// ---------------------------------------------------------------------------
// Infrastructure: Sales SQLite repository
//
// Implements ISalesRepository using better-sqlite3. Preserves the legacy
// complete/get/list Sales behavior — no logic or semantic changes.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  assertOfflineEligible,
  getActorUserId,
  markOfflineWorkRequiresRevalidation,
} from "../../offline-auth";
import type { IOutboxRepository, OutboxEntryInput } from "../../ports/outbox-repository";
import type { ISalesRepository } from "../../domain/sales/sales-repository";
import {
  FiscalBlockedError,
  type ListedSale,
  type OfflineSaleInput,
  type OfflineSaleResult,
  type SaleLookupResult,
  type StockMovementResult,
} from "../../domain/sales/sale";

export interface DetailedSaleItemRecord {
  productId: string;
  name: string;
  description?: string;
  quantity: number;
  unitPrice: string;
  subtotal: string;
  discountAmount: string;
  appliedPromotions: [];
  appliedPromotionId: string | null;
  appliedPromotionType: string | null;
}

export interface DetailedSalePaymentRecord {
  method: string;
  amount: string;
}

export interface DetailedSaleRecord {
  id: string;
  total: string;
  customer: string;
  invoiceStatus: string;
  createdAt: string;
  updatedAt: string;
  items: DetailedSaleItemRecord[];
  paymentMethods: DetailedSalePaymentRecord[];
  splitTicketGroups: null;
  cae: null;
  caeVto: null;
  cbteNro: null;
  cbteTipo: null;
  ptoVta: null;
  invoiceRequestedAt: null;
}

// ---------------------------------------------------------------------------
// Helpers preserved from the previous Sales persistence implementation.
// ---------------------------------------------------------------------------

function getInstallationId(db: Database.Database): string {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = 'installation_id'")
    .get() as { value: string } | undefined;
  return row?.value || "unknown-install";
}

function now(): string {
  return new Date().toISOString();
}

function getLocalBalanceAfter(db: Database.Database, productId: string): number {
  const row = db
    .prepare("SELECT stock_actual FROM stock_balances WHERE product_id = ?")
    .get(productId) as { stock_actual: number } | undefined;
  return row?.stock_actual ?? 0;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class SalesSqliteRepository implements ISalesRepository {
  constructor(
    private readonly getDb: () => Database.Database,
    private readonly outboxRepository: IOutboxRepository,
  ) {}

  // -----------------------------------------------------------------------
  // Complete sale
  // -----------------------------------------------------------------------

  completeSale(input: OfflineSaleInput): OfflineSaleResult {
    const db = this.getDb();

    // -------------------------------------------------------------------
    // Offline auth guard (before any write)
    // -------------------------------------------------------------------
    assertOfflineEligible(db);

    // -------------------------------------------------------------------
    // Fiscal sale blocking gate (after auth, before writes)
    // -------------------------------------------------------------------
    if (input.invoiceRequested) {
      throw new FiscalBlockedError();
    }

    const saleId = randomUUID();
    const createdAt = now();
    const installationId = getInstallationId(db);
    const actorUserId = getActorUserId(db);

    const warnings: string[] = [];
    const stockMovements: StockMovementResult[] = [];

    const runTransaction = db.transaction(() => {
      // ---------------------------------------------------------------
      // 1. Insert sale
      // ---------------------------------------------------------------
      db.prepare(`
        INSERT INTO sales
          (id, total, customer, invoice_status, invoice_requested, created_at, updated_at)
        VALUES
          (@id, @total, @customer, 'none', 0, @created_at, @created_at)
      `).run({
        id: saleId,
        total: input.total,
        customer: "Mostrador",
        created_at: createdAt,
      });

      // ---------------------------------------------------------------
      // 2. Insert sale items
      // ---------------------------------------------------------------
      const insertItem = db.prepare(`
        INSERT INTO sale_items
          (id, sale_id, product_id, name, description, quantity, unit_price, subtotal, discount_amount, created_at)
        VALUES
          (@id, @sale_id, @product_id, @name, @description, @quantity, @unit_price, @subtotal, @discount_amount, @created_at)
      `);

      for (const item of input.items) {
        insertItem.run({
          id: randomUUID(),
          sale_id: saleId,
          product_id: item.productId,
          name: item.name,
          description: item.description ?? null,
          quantity: item.quantity,
          unit_price: item.unitPrice,
          subtotal: item.subtotal,
          discount_amount: item.discountAmount,
          created_at: createdAt,
        });
      }

      // ---------------------------------------------------------------
      // 3. Insert sale payments
      // ---------------------------------------------------------------
      const insertPayment = db.prepare(`
        INSERT INTO sale_payments
          (id, sale_id, method, amount, created_at)
        VALUES
          (@id, @sale_id, @method, @amount, @created_at)
      `);

      for (const payment of input.payments) {
        insertPayment.run({
          id: randomUUID(),
          sale_id: saleId,
          method: payment.method,
          amount: payment.amount,
          created_at: createdAt,
        });
      }

      // ---------------------------------------------------------------
      // 4. Stock deduction + movement recording
      // ---------------------------------------------------------------
      const stockMovementIds: string[] = [];

      for (const item of input.items) {
        // Check if product tracks stock
        const product = db
          .prepare("SELECT maneja_stock FROM products WHERE id = ?")
          .get(item.productId) as { maneja_stock: number } | undefined;

        if (!product || product.maneja_stock === 0) continue;

        // Deduct stock
        const balanceBefore = db
          .prepare("SELECT stock_actual FROM stock_balances WHERE product_id = ?")
          .get(item.productId) as { stock_actual: number } | undefined;

        const newStock = (balanceBefore?.stock_actual ?? 0) - item.quantity;

        db.prepare(`
          INSERT INTO stock_balances (product_id, stock_actual, updated_at)
          VALUES (@product_id, @stock_actual, @updated_at)
          ON CONFLICT(product_id) DO UPDATE SET
            stock_actual = @stock_actual,
            updated_at = @updated_at
        `).run({
          product_id: item.productId,
          stock_actual: newStock,
          updated_at: createdAt,
        });

        // Record stock movement
        const movementId = randomUUID();
        db.prepare(`
          INSERT INTO stock_movements
            (id, product_id, quantity, reason, sale_id, created_at)
          VALUES
            (@id, @product_id, @quantity, @reason, @sale_id, @created_at)
        `).run({
          id: movementId,
          product_id: item.productId,
          quantity: -item.quantity,
          reason: "sale",
          sale_id: saleId,
          created_at: createdAt,
        });

        stockMovementIds.push(movementId);

        stockMovements.push({
          productId: item.productId,
          quantity: -item.quantity,
          reason: "sale",
          saleId,
        });

        // Negative stock warning
        if (newStock < 0) {
          warnings.push(
            `Negative stock for product ${item.productId} (${item.name}): balance is ${newStock}. Will be reconciled on sync.`,
          );
        }
      }

      // ---------------------------------------------------------------
      // 5. Outbox entries (durable, in the same transaction)
      //    a) sale_create first, via shared IOutboxRepository
      //    b) stock_adjust per stock movement, via shared IOutboxRepository
      // ---------------------------------------------------------------

      const salePayload = {
        saleId,
        total: input.total,
        items: input.items.map((i) => ({
          productId: i.productId,
          name: i.name,
          description: i.description,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
          subtotal: i.subtotal,
          discountAmount: i.discountAmount,
        })),
        payments: input.payments,
        createdAt,
      };

      const saleCreateEntry: OutboxEntryInput = {
        operationType: "sale_create",
        aggregateType: "sale",
        aggregateId: saleId,
        payload: salePayload,
        createdAt,
        installationId,
        actorUserId,
        entityLabel: `Sale ${saleId.slice(0, 8)} — ${input.total}`,
      };

      this.outboxRepository.enqueue(saleCreateEntry);

      // Read back the generated sale_create outbox id
      const outboxId = this.readBackOutboxId(db, saleId);

      // Stock adjust outbox entries — one per stock-managed product
      for (let i = 0; i < stockMovements.length; i++) {
        const sm = stockMovements[i];
        const movementId = stockMovementIds[i];

        const stockPayload = {
          sale_id: saleId,
          stock_movement_id: movementId,
          product_id: sm.productId,
          quantity: sm.quantity,
          reason: sm.reason,
          local_balance_after: getLocalBalanceAfter(db, sm.productId),
        };

        const stockAdjustEntry: OutboxEntryInput = {
          operationType: "stock_adjust",
          aggregateType: "stock",
          aggregateId: sm.productId,
          payload: stockPayload,
          createdAt,
          installationId,
          actorUserId,
          entityLabel: `Stock adjust: ${sm.productId}`,
        };

        this.outboxRepository.enqueue(stockAdjustEntry);
      }

      // ---------------------------------------------------------------
      // 6. Mark revalidation required after offline write
      // ---------------------------------------------------------------
      markOfflineWorkRequiresRevalidation(db);

      return outboxId;
    });

    const outboxId = runTransaction() as unknown as string;

    return {
      sale: {
        id: saleId,
        total: input.total,
        customer: "Mostrador",
        invoiceStatus: "none",
        invoiceRequested: false,
        createdAt,
      },
      stockMovements: stockMovements.length > 0 ? stockMovements : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      outboxId,
    };
  }

  // -----------------------------------------------------------------------
  // Get sale by id
  // -----------------------------------------------------------------------

  getSaleById(saleId: string): SaleLookupResult | undefined {
    const db = this.getDb();

    const sale = db.prepare(`
      SELECT id, total, customer, invoice_status, invoice_requested, created_at
      FROM sales WHERE id = ?
    `).get(saleId) as {
      id: string;
      total: string;
      customer: string;
      invoice_status: string;
      invoice_requested: number;
      created_at: string;
    } | undefined;

    if (!sale) return undefined;

    return {
      id: sale.id,
      total: sale.total,
      customer: sale.customer,
      invoiceStatus: sale.invoice_status,
      createdAt: sale.created_at,
    };
  }

  // -----------------------------------------------------------------------
  // List sales
  // -----------------------------------------------------------------------

  listSales(): ListedSale[] {
    const db = this.getDb();

    const rows = db
      .prepare(
        `SELECT
           s.id, s.total, s.customer, s.invoice_status, s.invoice_requested, s.created_at,
           o.status AS sync_status
         FROM sales s
         LEFT JOIN outbox o ON o.aggregate_type = 'sale' AND o.aggregate_id = s.id
           AND o.operation_type = 'sale_create'
         ORDER BY s.created_at DESC`,
      )
      .all() as {
        id: string;
        total: string;
        customer: string;
        invoice_status: string;
        invoice_requested: number;
        created_at: string;
        sync_status: string | null;
      }[];

    return rows.map((r) => ({
      id: r.id,
      total: r.total,
      customer: r.customer,
      invoiceStatus: r.invoice_status,
      invoiceRequested: r.invoice_requested === 1,
      createdAt: r.created_at,
      syncStatus: r.sync_status,
    }));
  }

  getDetailedSaleById(saleId: string): DetailedSaleRecord | undefined {
    const db = this.getDb();

    const sale = db.prepare(`
      SELECT id, total, customer, invoice_status, created_at, updated_at
      FROM sales WHERE id = ?
    `).get(saleId) as {
      id: string;
      total: string;
      customer: string;
      invoice_status: string;
      created_at: string;
      updated_at: string;
    } | undefined;

    if (!sale) {
      return undefined;
    }

    return {
      id: sale.id,
      total: sale.total,
      customer: sale.customer,
      invoiceStatus: sale.invoice_status,
      createdAt: sale.created_at,
      updatedAt: sale.updated_at,
      items: this.readSaleItems(db, sale.id),
      paymentMethods: this.readSalePayments(db, sale.id),
      splitTicketGroups: null,
      cae: null,
      caeVto: null,
      cbteNro: null,
      cbteTipo: null,
      ptoVta: null,
      invoiceRequestedAt: null,
    };
  }

  listDetailedSales(): DetailedSaleRecord[] {
    return this.listSales()
      .map((sale) => this.getDetailedSaleById(sale.id))
      .filter((sale): sale is DetailedSaleRecord => sale !== undefined);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Read back the outbox row id for the sale_create entry that was just
   * inserted. This MUST run inside the same transaction as the insert.
   */
  private readSaleItems(db: Database.Database, saleId: string): DetailedSaleItemRecord[] {
    return db.prepare(`
      SELECT
        product_id AS productId,
        name,
        description,
        quantity,
        unit_price AS unitPrice,
        subtotal,
        discount_amount AS discountAmount,
        applied_promotion_id AS appliedPromotionId,
        applied_promotion_type AS appliedPromotionType
      FROM sale_items
      WHERE sale_id = ?
      ORDER BY created_at ASC
    `).all(saleId).map((item) => ({
      ...(item as Omit<DetailedSaleItemRecord, "appliedPromotions">),
      appliedPromotions: [],
    })) as DetailedSaleItemRecord[];
  }

  private readSalePayments(db: Database.Database, saleId: string): DetailedSalePaymentRecord[] {
    return db.prepare(`
      SELECT method, amount
      FROM sale_payments
      WHERE sale_id = ?
      ORDER BY created_at ASC
    `).all(saleId) as DetailedSalePaymentRecord[];
  }

  private readBackOutboxId(db: Database.Database, saleId: string): string {
    const row = db
      .prepare(
        `SELECT id FROM outbox
         WHERE aggregate_type = 'sale'
           AND aggregate_id = ?
           AND operation_type = 'sale_create'
         ORDER BY rowid DESC
         LIMIT 1`,
      )
      .get(saleId) as { id: string } | undefined;

    if (!row) {
      throw new Error("Failed to read back sale_create outbox id — transaction consistency error");
    }

    return row.id;
  }
}
