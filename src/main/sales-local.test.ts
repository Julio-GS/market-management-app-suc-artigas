import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { getDatabasePath, openDatabase, closeDatabase, runMigrations } from "./db";
import {
  completeOfflineSale,
  type OfflineSaleInput,
  type OfflineSaleResult,
  FiscalBlockedError,
} from "./sales-local";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-sales-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createTestDb(dir: string): Database.Database {
  const dbPath = getDatabasePath(dir);
  const db = openDatabase(dbPath);
  runMigrations(db);
  // Seed a product with stock for test scenarios
  db.prepare(`
    INSERT OR REPLACE INTO products
      (id, detalle, costo_neto, costo_final, iva, cambio_costo, cambio_precio,
       etiqueta, facturable, maneja_stock, codigos, pricing_mode, is_protected,
       created_at, updated_at)
    VALUES
      ('prod-1', 'Test Product', NULL, NULL, NULL, 'fixed', 'fixed',
       '', 0, 1, '[]', 'fixed', 0, '2026-01-01', '2026-01-01')
  `).run();
  db.prepare(`
    INSERT OR REPLACE INTO stock_balances (product_id, stock_actual, updated_at)
    VALUES ('prod-1', 10, '2026-01-01')
  `).run();
  return db;
}

const validOfflineSale: OfflineSaleInput = {
  items: [
    {
      productId: "prod-1",
      name: "Test Product",
      quantity: 2,
      unitPrice: "100.00",
      subtotal: "200.00",
      discountAmount: "0.00",
    },
  ],
  payments: [{ method: "cash", amount: "200.00" }],
  invoiceRequested: false,
  total: "200.00",
};

describe("completeOfflineSale", () => {
  let dir: string;
  let db: Database.Database;

  describe("offline auth guard (RED — currently succeeds without session)", () => {
    beforeEach(() => {
      dir = tempDir();
      db = createTestDb(dir);
    });

    afterEach(() => {
      closeDatabase(db);
      cleanup(dir);
    });

    it("rejects the sale when no offline session exists", () => {
      // createTestDb does NOT seed an offline session
      // In the RED phase, this SHOULD FAIL (sale currently succeeds without session)
      expect(() => completeOfflineSale(db, validOfflineSale)).toThrow();
    });

    it("accepts the sale when an offline session exists", () => {
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();

      expect(() => completeOfflineSale(db, validOfflineSale)).not.toThrow();
    });
  });

  describe("non-fiscal offline sale persistence", () => {
    beforeEach(() => {
      dir = tempDir();
      db = createTestDb(dir);
      // Seed a session for auth
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();
    });

    afterEach(() => {
      closeDatabase(db);
      cleanup(dir);
    });

    it("persists a non-fiscal sale to the sales table", () => {
      const result = completeOfflineSale(db, validOfflineSale);
      expect(result.sale).toBeDefined();
      expect(result.sale.id).toBeTruthy();

      const row = db.prepare("SELECT * FROM sales WHERE id = ?").get(result.sale.id) as Record<string, unknown> | undefined;
      expect(row).toBeDefined();
      expect(row!.total).toBe("200.00");
      expect(row!.invoice_requested).toBe(0);
    });

    it("persists sale items with the sale", () => {
      const result = completeOfflineSale(db, validOfflineSale);
      const items = db.prepare("SELECT * FROM sale_items WHERE sale_id = ?").all(result.sale.id) as unknown[];
      expect(items).toHaveLength(1);
      expect((items[0] as Record<string, unknown>).product_id).toBe("prod-1");
      expect((items[0] as Record<string, unknown>).quantity).toBe(2);
    });

    it("persists sale payments with the sale", () => {
      const result = completeOfflineSale(db, validOfflineSale);
      const payments = db.prepare("SELECT * FROM sale_payments WHERE sale_id = ?").all(result.sale.id) as unknown[];
      expect(payments).toHaveLength(1);
      expect((payments[0] as Record<string, unknown>).method).toBe("cash");
    });

    it("creates an outbox entry for the sale in the same transaction", () => {
      const result = completeOfflineSale(db, validOfflineSale);
      const outboxEntries = db.prepare("SELECT * FROM outbox WHERE aggregate_id = ?").all(result.sale.id) as unknown[];
      // There should be a sale_create entry (aggregate_id matches the sale)
      const saleCreates = (outboxEntries as { operation_type: string }[]).filter(
        (e) => e.operation_type === "sale_create",
      );
      expect(saleCreates).toHaveLength(1);
      const entry = saleCreates[0] as Record<string, unknown>;
      expect(entry.operation_type).toBe("sale_create");
      expect(entry.aggregate_type).toBe("sale");
      expect(entry.status).toBe("pending");
      expect(entry.idempotency_key).toBeTruthy();
    });

    it("survives restart — sale is still present after close/reopen", () => {
      const result = completeOfflineSale(db, validOfflineSale);
      const saleId = result.sale.id;

      closeDatabase(db);
      const db2 = openDatabase(getDatabasePath(dir));
      try {
        const row = db2.prepare("SELECT id FROM sales WHERE id = ?").get(saleId) as { id: string } | undefined;
        expect(row).toBeDefined();
        expect(row!.id).toBe(saleId);

        const outbox = db2.prepare("SELECT id FROM outbox WHERE aggregate_id = ?").all(saleId) as unknown[];
        expect(outbox.length).toBeGreaterThanOrEqual(1);
      } finally {
        closeDatabase(db2);
      }
    });

    it("deducts stock for maneja_stock products", () => {
      const result = completeOfflineSale(db, validOfflineSale);
      const balance = db.prepare("SELECT stock_actual FROM stock_balances WHERE product_id = ?").get("prod-1") as { stock_actual: number };
      expect(balance.stock_actual).toBe(8); // 10 - 2
      expect(result.stockMovements).toBeDefined();
      expect(result.stockMovements!.length).toBe(1);
      expect(result.stockMovements![0].productId).toBe("prod-1");
      expect(result.stockMovements![0].quantity).toBe(-2);
    });

    it("records stock_movements for deducting products", () => {
      completeOfflineSale(db, validOfflineSale);
      const movements = db.prepare("SELECT * FROM stock_movements WHERE product_id = ?").all("prod-1") as unknown[];
      expect(movements).toHaveLength(1);
      const m = movements[0] as Record<string, unknown>;
      expect(m.quantity).toBe(-2);
      expect(m.reason).toBe("sale");
    });

    it("allows negative stock and returns a warning", () => {
      const largeSale: OfflineSaleInput = {
        ...validOfflineSale,
        items: [{ ...validOfflineSale.items[0], quantity: 15 }],
        payments: [{ method: "cash", amount: "1500.00" }],
        total: "1500.00",
      };

      const result = completeOfflineSale(db, largeSale);
      expect(result.sale).toBeDefined();

      const balance = db.prepare("SELECT stock_actual FROM stock_balances WHERE product_id = ?").get("prod-1") as { stock_actual: number };
      expect(balance.stock_actual).toBe(-5); // 10 - 15

      expect(result.warnings).toBeDefined();
      expect(result.warnings!.length).toBeGreaterThan(0);
      expect(result.warnings!.some((w) => w.toLowerCase().includes("negative stock"))).toBe(true);
    });
  });

  describe("fiscal sale blocking", () => {
    beforeEach(() => {
      dir = tempDir();
      db = createTestDb(dir);
      // Seed a session so auth guard passes before fiscal check
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();
    });

    afterEach(() => {
      closeDatabase(db);
      cleanup(dir);
    });

    it("hard-blocks a fiscal sale when invoiceRequested is true", () => {
      const fiscalSale: OfflineSaleInput = {
        ...validOfflineSale,
        invoiceRequested: true,
      };

      expect(() => completeOfflineSale(db, fiscalSale)).toThrow(FiscalBlockedError);
    });

    it("leaves no sale record behind when blocked", () => {
      const fiscalSale: OfflineSaleInput = {
        ...validOfflineSale,
        invoiceRequested: true,
      };

      try {
        completeOfflineSale(db, fiscalSale);
      } catch {
        // expected
      }

      const sales = db.prepare("SELECT COUNT(*) as cnt FROM sales").get() as { cnt: number };
      expect(sales.cnt).toBe(0);
    });

    it("throws FiscalBlockedError with a descriptive message", () => {
      const fiscalSale: OfflineSaleInput = {
        ...validOfflineSale,
        invoiceRequested: true,
      };

      try {
        completeOfflineSale(db, fiscalSale);
        expect.unreachable("Expected FiscalBlockedError");
      } catch (err) {
        expect(err).toBeInstanceOf(FiscalBlockedError);
        expect((err as Error).message.toLowerCase()).toContain("fiscal");
      }
    });
  });

  describe("outbox durability guarantees", () => {
    beforeEach(() => {
      dir = tempDir();
      db = createTestDb(dir);
      // Seed a session for auth
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();
    });

    afterEach(() => {
      closeDatabase(db);
      cleanup(dir);
    });

    it("outbox entry status defaults to pending", () => {
      const result = completeOfflineSale(db, validOfflineSale);
      const entry = db.prepare("SELECT status FROM outbox WHERE aggregate_id = ? AND operation_type = 'sale_create'").get(result.sale.id) as { status: string };
      expect(entry.status).toBe("pending");
    });

    it("outbox entry has idempotency_key matching installation_id prefix", () => {
      // Ensure installation_id exists in metadata
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('installation_id', 'test-install-123')").run();

      const result = completeOfflineSale(db, validOfflineSale);
      const entry = db.prepare("SELECT idempotency_key FROM outbox WHERE aggregate_id = ? AND operation_type = 'sale_create'").get(result.sale.id) as { idempotency_key: string };
      expect(entry.idempotency_key).toContain("test-install-123");
    });

    it("outbox payload contains the serialized sale data", () => {
      const result = completeOfflineSale(db, validOfflineSale);
      const entry = db.prepare("SELECT payload FROM outbox WHERE aggregate_id = ? AND operation_type = 'sale_create'").get(result.sale.id) as { payload: string };
      const payload = JSON.parse(entry.payload);
      expect(payload.total).toBe("200.00");
      expect(payload.items).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  // Stock adjust outbox entries — one per stock movement
  // -------------------------------------------------------------------

  describe("stock_adjust outbox entries (RED)", () => {
    beforeEach(() => {
      dir = tempDir();
      db = createTestDb(dir);
      // Seed a session for auth
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();
    });

    afterEach(() => {
      closeDatabase(db);
      cleanup(dir);
    });

    it("creates a stock_adjust outbox entry for each stock-managed product", () => {
      // Add a second stock-managed product
      db.prepare(`
        INSERT OR REPLACE INTO products
          (id, detalle, costo_neto, costo_final, iva, cambio_costo, cambio_precio,
           etiqueta, facturable, maneja_stock, codigos, pricing_mode, is_protected,
           created_at, updated_at)
        VALUES
          ('prod-2', 'Another Product', NULL, NULL, NULL, 'fixed', 'fixed',
           '', 0, 1, '[]', 'fixed', 0, '2026-01-01', '2026-01-01')
      `).run();
      db.prepare("INSERT OR REPLACE INTO stock_balances (product_id, stock_actual, updated_at) VALUES ('prod-2', 20, '2026-01-01')").run();

      const multiItemSale: OfflineSaleInput = {
        items: [
          { ...validOfflineSale.items[0], productId: "prod-1", quantity: 2 },
          { ...validOfflineSale.items[0], productId: "prod-2", quantity: 3, name: "Another Product" },
        ],
        payments: [{ method: "cash", amount: "500.00" }],
        invoiceRequested: false,
        total: "500.00",
      };

      completeOfflineSale(db, multiItemSale);

      const stockAdjusts = db
        .prepare("SELECT * FROM outbox WHERE operation_type = 'stock_adjust' ORDER BY created_at ASC")
        .all() as { aggregate_id: string; payload: string }[];
      expect(stockAdjusts).toHaveLength(2);
      // One per product
      const productIds = stockAdjusts.map((e) => e.aggregate_id);
      expect(productIds).toContain("prod-1");
      expect(productIds).toContain("prod-2");
    });

    it("stock_adjust payload includes sale_id, product_id, quantity, reason, and local_balance_after", () => {
      completeOfflineSale(db, validOfflineSale);

      const stockAdjust = db
        .prepare("SELECT * FROM outbox WHERE operation_type = 'stock_adjust' LIMIT 1")
        .get() as { payload: string; aggregate_id: string } | undefined;
      expect(stockAdjust).toBeDefined();

      const payload = JSON.parse(stockAdjust!.payload);
      expect(payload.sale_id).toBeDefined();
      expect(payload.product_id).toBe("prod-1");
      expect(payload.quantity).toBe(-2);
      expect(payload.reason).toBe("sale");
      expect(payload.local_balance_after).toBe(8); // 10 - 2
    });

    it("stock_adjust and sale_create outbox entries are ordered in the same transaction (sale_create first)", () => {
      completeOfflineSale(db, validOfflineSale);

      const entries = db
        .prepare("SELECT operation_type FROM outbox ORDER BY created_at ASC, rowid ASC")
        .all() as { operation_type: string }[];

      // sale_create should come before stock_adjust
      expect(entries.length).toBeGreaterThanOrEqual(2);
      expect(entries[0].operation_type).toBe("sale_create");
      expect(entries[1].operation_type).toBe("stock_adjust");
    });
  });

  // -------------------------------------------------------------------
  // Outbox metadata fields (local_device_timestamp, actor_user_id, entity_label)
  // -------------------------------------------------------------------

  describe("outbox metadata (RED)", () => {
    beforeEach(() => {
      dir = tempDir();
      db = createTestDb(dir);
      // Seed a session for auth
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();
    });

    afterEach(() => {
      closeDatabase(db);
      cleanup(dir);
    });

    it("records local_device_timestamp on the sale_create outbox entry", () => {
      completeOfflineSale(db, validOfflineSale);

      const saleEntry = db
        .prepare("SELECT local_device_timestamp FROM outbox WHERE operation_type = 'sale_create' LIMIT 1")
        .get() as { local_device_timestamp: string | null };
      expect(saleEntry.local_device_timestamp).toBeTruthy();
      expect(() => new Date(saleEntry.local_device_timestamp!)).not.toThrow();
    });

    it("records local_device_timestamp on stock_adjust outbox entries", () => {
      completeOfflineSale(db, validOfflineSale);

      const stockEntry = db
        .prepare("SELECT local_device_timestamp FROM outbox WHERE operation_type = 'stock_adjust' LIMIT 1")
        .get() as { local_device_timestamp: string | null };
      expect(stockEntry.local_device_timestamp).toBeTruthy();
    });

    it("records actor_user_id from the cached offline session", () => {
      completeOfflineSale(db, validOfflineSale);

      const saleEntry = db
        .prepare("SELECT actor_user_id FROM outbox WHERE operation_type = 'sale_create' LIMIT 1")
        .get() as { actor_user_id: string | null };
      expect(saleEntry.actor_user_id).toBe("user-1");
    });

    it("sets entity_label on the sale_create outbox entry", () => {
      completeOfflineSale(db, validOfflineSale);

      const saleEntry = db
        .prepare("SELECT entity_label FROM outbox WHERE operation_type = 'sale_create' LIMIT 1")
        .get() as { entity_label: string | null };
      expect(saleEntry.entity_label).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------
  // Revalidation flag after offline sale
  // -------------------------------------------------------------------

  describe("revalidation flag after offline sale (RED)", () => {
    beforeEach(() => {
      dir = tempDir();
      db = createTestDb(dir);
      // Seed a session for auth
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();
    });

    afterEach(() => {
      closeDatabase(db);
      cleanup(dir);
    });

    it("sets revalidation_required flag after completing an offline sale", () => {
      completeOfflineSale(db, validOfflineSale);

      const row = db
        .prepare("SELECT value FROM metadata WHERE key = 'revalidation_required'")
        .get() as { value: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.value).toBe("1");
    });
  });
});
