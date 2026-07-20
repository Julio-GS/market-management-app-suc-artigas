import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

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
 * - Validates that invoiceRequested is false (fiscal blocking).
 * - Inserts the sale, items, and payments.
 * - Deducts stock for products that track stock (maneja_stock).
 * - Records stock movements (negative is allowed with warning).
 * - Creates a durable outbox entry in the same transaction.
 *
 * Throws `FiscalBlockedError` when `invoiceRequested` is true.
 */
export function completeOfflineSale(
  db: Database.Database,
  input: OfflineSaleInput,
): OfflineSaleResult {
  // -----------------------------------------------------------------------
  // Fiscal sale blocking gate
  // -----------------------------------------------------------------------
  if (input.invoiceRequested) {
    throw new FiscalBlockedError();
  }

  const saleId = randomUUID();
  const createdAt = now();
  const installationId = getInstallationId(db);

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
    // 5. Outbox entry (durable, in the same transaction)
    // -------------------------------------------------------------------
    const outboxId = randomUUID();
    const idempotencyKey = `${installationId}:${outboxId}`;

    const payload = JSON.stringify({
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

    db.prepare(`
      INSERT INTO outbox
        (id, idempotency_key, operation_type, aggregate_type, aggregate_id,
         payload, status, attempt_count, created_at, updated_at)
      VALUES
        (@id, @idempotency_key, @operation_type, @aggregate_type, @aggregate_id,
         @payload, 'pending', 0, @created_at, @created_at)
    `).run({
      id: outboxId,
      idempotency_key: idempotencyKey,
      operation_type: "sale_create",
      aggregate_type: "sale",
      aggregate_id: saleId,
      payload,
      created_at: createdAt,
    });

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
