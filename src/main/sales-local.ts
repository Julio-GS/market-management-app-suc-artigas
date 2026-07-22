import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  getOfflineSession,
  assertOfflineEligible,
  getActorUserId,
  markOfflineWorkRequiresRevalidation,
  OfflineAuthRequiredError,
} from "./offline-auth";

// Re-export for IPC error mapping
export { OfflineAuthRequiredError };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OfflineSaleItemInput {
  productId: string;
  name: string;
  description?: string;
  quantity: number;
  unitPrice: string;
  subtotal: string;
  discountAmount: string;
}

export interface OfflineSalePaymentInput {
  method: string;
  amount: string;
}

export interface OfflineSaleInput {
  items: OfflineSaleItemInput[];
  payments: OfflineSalePaymentInput[];
  invoiceRequested: boolean;
  total: string;
}

export interface OfflineSaleResultSale {
  id: string;
  total: string;
  customer: string;
  invoiceStatus: string;
  invoiceRequested: boolean;
  createdAt: string;
}

export interface StockMovementResult {
  productId: string;
  quantity: number;
  reason: string;
  saleId: string;
}

export interface OfflineSaleResult {
  sale: OfflineSaleResultSale;
  stockMovements?: StockMovementResult[];
  warnings?: string[];
  outboxId: string;
}

export class FiscalBlockedError extends Error {
  constructor() {
    super("Fiscal/invoice sales are not available offline. Please reconnect to complete this sale.");
    this.name = "FiscalBlockedError";
  }
}

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// Main operation
// ---------------------------------------------------------------------------

/**
 * Complete a non-fiscal sale locally within a single SQLite transaction.
 *
 * - Validates that an offline session exists (auth guard).
 * - Validates that invoiceRequested is false (fiscal blocking).
 * - Inserts the sale, items, and payments.
 * - Deducts stock for products that track stock (maneja_stock).
 * - Records stock movements (negative is allowed with warning).
 * - Creates a durable `sale_create` outbox entry followed by one
 *   `stock_adjust` outbox entry per stock movement, all in the same
 *   transaction.
 * - Marks revalidation-required after the write.
 *
 * Throws `FiscalBlockedError` when `invoiceRequested` is true.
 * Throws `OfflineAuthRequiredError` when no cached session exists.
 */
export function completeOfflineSale(
  db: Database.Database,
  input: OfflineSaleInput,
): OfflineSaleResult {
  // -----------------------------------------------------------------------
  // Offline auth guard
  // -----------------------------------------------------------------------
  assertOfflineEligible(db);

  // -----------------------------------------------------------------------
  // Fiscal sale blocking gate
  // -----------------------------------------------------------------------
  if (input.invoiceRequested) {
    throw new FiscalBlockedError();
  }

  const saleId = randomUUID();
  const createdAt = now();
  const installationId = getInstallationId(db);
  const actorUserId = getActorUserId(db);

  const warnings: string[] = [];
  const stockMovements: StockMovementResult[] = [];

  const run = db.transaction(() => {
    // -------------------------------------------------------------------
    // 1. Insert sale
    // -------------------------------------------------------------------
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

    // -------------------------------------------------------------------
    // 2. Insert sale items
    // -------------------------------------------------------------------
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

    // -------------------------------------------------------------------
    // 3. Insert sale payments
    // -------------------------------------------------------------------
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

    // -------------------------------------------------------------------
    // 4. Stock deduction + movement recording
    // -------------------------------------------------------------------
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

    // -------------------------------------------------------------------
    // 5. Outbox entries (durable, in the same transaction)
    //    a) sale_create first
    //    b) stock_adjust per stock movement
    // -------------------------------------------------------------------

    const insertOutbox = db.prepare(`
      INSERT INTO outbox
        (id, idempotency_key, operation_type, aggregate_type, aggregate_id,
         payload, status, attempt_count, created_at, updated_at,
         local_device_timestamp, actor_user_id, entity_label)
      VALUES
        (@id, @idempotency_key, @operation_type, @aggregate_type, @aggregate_id,
         @payload, 'pending', 0, @created_at, @created_at,
         @local_device_timestamp, @actor_user_id, @entity_label)
    `);

    const outboxId = randomUUID();
    const idempotencyKey = `${installationId}:${outboxId}`;

    const salePayload = JSON.stringify({
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
    });

    insertOutbox.run({
      id: outboxId,
      idempotency_key: idempotencyKey,
      operation_type: "sale_create",
      aggregate_type: "sale",
      aggregate_id: saleId,
      payload: salePayload,
      created_at: createdAt,
      local_device_timestamp: createdAt,
      actor_user_id: actorUserId,
      entity_label: `Sale ${saleId.slice(0, 8)} — ${input.total}`,
    });

    // Stock adjust outbox entries — one per stock-managed product
    for (let i = 0; i < stockMovements.length; i++) {
      const sm = stockMovements[i];
      const movementId = stockMovementIds[i];

      const stockPayload = JSON.stringify({
        sale_id: saleId,
        stock_movement_id: movementId,
        product_id: sm.productId,
        quantity: sm.quantity,
        reason: sm.reason,
        local_balance_after: getLocalBalanceAfter(db, sm.productId),
      });

      const stockOutboxId = randomUUID();
      const stockIdempotencyKey = `${installationId}:${stockOutboxId}`;

      insertOutbox.run({
        id: stockOutboxId,
        idempotency_key: stockIdempotencyKey,
        operation_type: "stock_adjust",
        aggregate_type: "stock",
        aggregate_id: sm.productId,
        payload: stockPayload,
        created_at: createdAt,
        local_device_timestamp: createdAt,
        actor_user_id: actorUserId,
        entity_label: `Stock adjust: ${sm.productId}`,
      });
    }

    // -------------------------------------------------------------------
    // 6. Mark revalidation required after offline write
    // -------------------------------------------------------------------
    markOfflineWorkRequiresRevalidation(db);

    return outboxId;
  });

  const outboxId = run() as unknown as string;

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

/**
 * Return the current stock_actual for a product after any recent writes
 * within the same transaction. Used to populate `local_balance_after` in
 * stock_adjust outbox payloads.
 */
function getLocalBalanceAfter(db: Database.Database, productId: string): number {
  const row = db
    .prepare("SELECT stock_actual FROM stock_balances WHERE product_id = ?")
    .get(productId) as { stock_actual: number } | undefined;
  return row?.stock_actual ?? 0;
}

// ---------------------------------------------------------------------------
// Sales listing — exposes local sale records for sync-state visibility
// ---------------------------------------------------------------------------

export interface ListedSale {
  id: string;
  total: string;
  customer: string;
  invoiceStatus: string;
  invoiceRequested: boolean;
  createdAt: string;
  syncStatus?: string | null;
}

export function listOfflineSales(db: Database.Database): ListedSale[] {
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
