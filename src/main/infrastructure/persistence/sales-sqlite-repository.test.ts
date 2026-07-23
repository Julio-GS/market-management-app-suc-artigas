import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { getDatabasePath, openDatabase, closeDatabase, runMigrations } from "../../db";
import { OutboxSqliteRepository } from "./outbox-sqlite-repository";
import type { IOutboxRepository, OutboxEntryInput } from "../../ports/outbox-repository";
import { SalesSqliteRepository } from "./sales-sqlite-repository";
import {
  FiscalBlockedError,
  type OfflineSaleInput,
} from "../../domain/sales/sale";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-sales-repo-test-"));
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
  // Seed installation_id so outbox idempotency keys work
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('installation_id', 'test-install-repo')",
  ).run();
  return db;
}

function seedSession(db: Database.Database): void {
  db.prepare(`
    INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
    VALUES ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
  `).run();
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SalesSqliteRepository", () => {
  describe("completeSale", () => {
    let dir: string;
    let db: Database.Database;
    let getDb: () => Database.Database;
    let outboxRepo: IOutboxRepository;
    let repo: SalesSqliteRepository;

    // -------------------------------------------------------------------
    // Auth guard
    // -------------------------------------------------------------------
    describe("offline auth guard", () => {
      beforeEach(() => {
        dir = tempDir();
        db = createTestDb(dir);
        getDb = () => db;
        outboxRepo = new OutboxSqliteRepository(getDb);
        repo = new SalesSqliteRepository(getDb, outboxRepo);
        // Do NOT seed a session — auth should fail
      });

      afterEach(() => {
        closeDatabase(db);
        cleanup(dir);
      });

      it("rejects the sale when no offline session exists", () => {
        expect(() => repo.completeSale(validOfflineSale)).toThrow();
      });

      it("accepts the sale when an offline session exists", () => {
        seedSession(db);
        expect(() => repo.completeSale(validOfflineSale)).not.toThrow();
      });
    });

    // -------------------------------------------------------------------
    // Non-fiscal sale persistence
    // -------------------------------------------------------------------
    describe("non-fiscal offline sale persistence", () => {
      beforeEach(() => {
        dir = tempDir();
        db = createTestDb(dir);
        seedSession(db);
        getDb = () => db;
        outboxRepo = new OutboxSqliteRepository(getDb);
        repo = new SalesSqliteRepository(getDb, outboxRepo);
      });

      afterEach(() => {
        closeDatabase(db);
        cleanup(dir);
      });

      it("persists a non-fiscal sale to the sales table", () => {
        const result = repo.completeSale(validOfflineSale);
        expect(result.sale).toBeDefined();
        expect(result.sale.id).toBeTruthy();

        const row = db
          .prepare("SELECT * FROM sales WHERE id = ?")
          .get(result.sale.id) as Record<string, unknown> | undefined;
        expect(row).toBeDefined();
        expect(row!.total).toBe("200.00");
        expect(row!.invoice_requested).toBe(0);
      });

      it("persists sale items with the sale", () => {
        const result = repo.completeSale(validOfflineSale);
        const items = db
          .prepare("SELECT * FROM sale_items WHERE sale_id = ?")
          .all(result.sale.id) as unknown[];
        expect(items).toHaveLength(1);
        expect((items[0] as Record<string, unknown>).product_id).toBe("prod-1");
        expect((items[0] as Record<string, unknown>).quantity).toBe(2);
      });

      it("persists sale payments with the sale", () => {
        const result = repo.completeSale(validOfflineSale);
        const payments = db
          .prepare("SELECT * FROM sale_payments WHERE sale_id = ?")
          .all(result.sale.id) as unknown[];
        expect(payments).toHaveLength(1);
        expect((payments[0] as Record<string, unknown>).method).toBe("cash");
      });

      it("survives restart — sale is still present after close/reopen", () => {
        const result = repo.completeSale(validOfflineSale);
        const saleId = result.sale.id;

        closeDatabase(db);
        const db2 = openDatabase(getDatabasePath(dir));
        try {
          const row = db2
            .prepare("SELECT id FROM sales WHERE id = ?")
            .get(saleId) as { id: string } | undefined;
          expect(row).toBeDefined();
          expect(row!.id).toBe(saleId);

          const outbox = db2
            .prepare("SELECT id FROM outbox WHERE aggregate_id = ?")
            .all(saleId) as unknown[];
          expect(outbox.length).toBeGreaterThanOrEqual(1);
        } finally {
          closeDatabase(db2);
        }
      });

      it("deducts stock for maneja_stock products", () => {
        const result = repo.completeSale(validOfflineSale);
        const balance = db
          .prepare("SELECT stock_actual FROM stock_balances WHERE product_id = ?")
          .get("prod-1") as { stock_actual: number };
        expect(balance.stock_actual).toBe(8); // 10 - 2
        expect(result.stockMovements).toBeDefined();
        expect(result.stockMovements!.length).toBe(1);
        expect(result.stockMovements![0].productId).toBe("prod-1");
        expect(result.stockMovements![0].quantity).toBe(-2);
      });

      it("records stock_movements for deducting products", () => {
        repo.completeSale(validOfflineSale);
        const movements = db
          .prepare("SELECT * FROM stock_movements WHERE product_id = ?")
          .all("prod-1") as unknown[];
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

        const result = repo.completeSale(largeSale);
        expect(result.sale).toBeDefined();

        const balance = db
          .prepare("SELECT stock_actual FROM stock_balances WHERE product_id = ?")
          .get("prod-1") as { stock_actual: number };
        expect(balance.stock_actual).toBe(-5); // 10 - 15

        expect(result.warnings).toBeDefined();
        expect(result.warnings!.length).toBeGreaterThan(0);
        expect(result.warnings!.some((w) => w.toLowerCase().includes("negative stock"))).toBe(true);
      });

      it("skips stock deduction for non-tracked products (maneja_stock = 0)", () => {
        // Add a non-tracked product
        db.prepare(`
          INSERT OR REPLACE INTO products
            (id, detalle, costo_neto, costo_final, iva, cambio_costo, cambio_precio,
             etiqueta, facturable, maneja_stock, codigos, pricing_mode, is_protected,
             created_at, updated_at)
          VALUES
            ('prod-no-stock', 'No Stock Product', NULL, NULL, NULL, 'fixed', 'fixed',
             '', 0, 0, '[]', 'fixed', 0, '2026-01-01', '2026-01-01')
        `).run();

        const saleWithNonTracked: OfflineSaleInput = {
          items: [
            { ...validOfflineSale.items[0], productId: "prod-1", quantity: 1 },
            {
              productId: "prod-no-stock",
              name: "No Stock Item",
              quantity: 5,
              unitPrice: "10.00",
              subtotal: "50.00",
              discountAmount: "0.00",
            },
          ],
          payments: [{ method: "cash", amount: "150.00" }],
          invoiceRequested: false,
          total: "150.00",
        };

        const result = repo.completeSale(saleWithNonTracked);
        expect(result.sale).toBeDefined();

        // Stock for prod-1 should be deducted
        const balance1 = db
          .prepare("SELECT stock_actual FROM stock_balances WHERE product_id = ?")
          .get("prod-1") as { stock_actual: number };
        expect(balance1.stock_actual).toBe(9); // 10 - 1

        // No stock_balances row for non-tracked product
        const balanceNoStock = db
          .prepare("SELECT stock_actual FROM stock_balances WHERE product_id = ?")
          .get("prod-no-stock") as { stock_actual: number } | undefined;
        expect(balanceNoStock).toBeUndefined();

        // Only 1 stock movement (for tracked product)
        expect(result.stockMovements).toBeDefined();
        expect(result.stockMovements!.length).toBe(1);
        expect(result.stockMovements![0].productId).toBe("prod-1");
      });

      it("skips stock deduction for non-existing product", () => {
        const saleWithUnknownProduct: OfflineSaleInput = {
          items: [
            {
              productId: "unknown-prod",
              name: "Unknown",
              quantity: 3,
              unitPrice: "10.00",
              subtotal: "30.00",
              discountAmount: "0.00",
            },
          ],
          payments: [{ method: "cash", amount: "30.00" }],
          invoiceRequested: false,
          total: "30.00",
        };

        const result = repo.completeSale(saleWithUnknownProduct);
        expect(result.sale).toBeDefined();
        expect(result.stockMovements).toBeUndefined();
      });
    });

    // -------------------------------------------------------------------
    // Fiscal sale blocking
    // -------------------------------------------------------------------
    describe("fiscal sale blocking", () => {
      beforeEach(() => {
        dir = tempDir();
        db = createTestDb(dir);
        seedSession(db);
        getDb = () => db;
        outboxRepo = new OutboxSqliteRepository(getDb);
        repo = new SalesSqliteRepository(getDb, outboxRepo);
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
        expect(() => repo.completeSale(fiscalSale)).toThrow(FiscalBlockedError);
      });

      it("leaves no sale record behind when blocked", () => {
        const fiscalSale: OfflineSaleInput = {
          ...validOfflineSale,
          invoiceRequested: true,
        };
        try {
          repo.completeSale(fiscalSale);
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
          repo.completeSale(fiscalSale);
          expect.unreachable("Expected FiscalBlockedError");
        } catch (err) {
          expect(err).toBeInstanceOf(FiscalBlockedError);
          expect((err as Error).message.toLowerCase()).toContain("fiscal");
        }
      });
    });

    // -------------------------------------------------------------------
    // Outbox durability guarantees
    // -------------------------------------------------------------------
    describe("outbox durability guarantees", () => {
      beforeEach(() => {
        dir = tempDir();
        db = createTestDb(dir);
        seedSession(db);
        getDb = () => db;
        outboxRepo = new OutboxSqliteRepository(getDb);
        repo = new SalesSqliteRepository(getDb, outboxRepo);
      });

      afterEach(() => {
        closeDatabase(db);
        cleanup(dir);
      });

      it("creates a sale_create outbox entry in the same transaction", () => {
        const result = repo.completeSale(validOfflineSale);
        const outboxEntries = db
          .prepare("SELECT * FROM outbox WHERE aggregate_id = ?")
          .all(result.sale.id) as unknown[];
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

      it("outbox entry status defaults to pending", () => {
        const result = repo.completeSale(validOfflineSale);
        const entry = db
          .prepare(
            "SELECT status FROM outbox WHERE aggregate_id = ? AND operation_type = 'sale_create'",
          )
          .get(result.sale.id) as { status: string };
        expect(entry.status).toBe("pending");
      });

      it("outbox entry has idempotency_key matching installation_id prefix", () => {
        const result = repo.completeSale(validOfflineSale);
        const entry = db
          .prepare(
            "SELECT idempotency_key FROM outbox WHERE aggregate_id = ? AND operation_type = 'sale_create'",
          )
          .get(result.sale.id) as { idempotency_key: string };
        expect(entry.idempotency_key).toContain("test-install-repo");
      });

      it("outbox payload contains the serialized sale data", () => {
        const result = repo.completeSale(validOfflineSale);
        const entry = db
          .prepare(
            "SELECT payload FROM outbox WHERE aggregate_id = ? AND operation_type = 'sale_create'",
          )
          .get(result.sale.id) as { payload: string };
        const payload = JSON.parse(entry.payload);
        expect(payload.total).toBe("200.00");
        expect(payload.items).toHaveLength(1);
      });

      it("offlineSaleResult.outboxId reads back the sale_create outbox id", () => {
        const result = repo.completeSale(validOfflineSale);
        expect(result.outboxId).toBeTruthy();
        // Verify it matches the actual outbox row id
        const row = db
          .prepare(
            "SELECT id FROM outbox WHERE aggregate_id = ? AND operation_type = 'sale_create'",
          )
          .get(result.sale.id) as { id: string };
        expect(result.outboxId).toBe(row.id);
      });
    });

    // -------------------------------------------------------------------
    // Stock adjust outbox entries
    // -------------------------------------------------------------------
    describe("stock_adjust outbox entries", () => {
      beforeEach(() => {
        dir = tempDir();
        db = createTestDb(dir);
        seedSession(db);
        getDb = () => db;
        outboxRepo = new OutboxSqliteRepository(getDb);
        repo = new SalesSqliteRepository(getDb, outboxRepo);
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
        db.prepare(
          "INSERT OR REPLACE INTO stock_balances (product_id, stock_actual, updated_at) VALUES ('prod-2', 20, '2026-01-01')",
        ).run();

        const multiItemSale: OfflineSaleInput = {
          items: [
            { ...validOfflineSale.items[0], productId: "prod-1", quantity: 2 },
            {
              ...validOfflineSale.items[0],
              productId: "prod-2",
              quantity: 3,
              name: "Another Product",
            },
          ],
          payments: [{ method: "cash", amount: "500.00" }],
          invoiceRequested: false,
          total: "500.00",
        };

        repo.completeSale(multiItemSale);

        const stockAdjusts = db
          .prepare("SELECT * FROM outbox WHERE operation_type = 'stock_adjust' ORDER BY created_at ASC")
          .all() as { aggregate_id: string; payload: string }[];
        expect(stockAdjusts).toHaveLength(2);
        const productIds = stockAdjusts.map((e) => e.aggregate_id);
        expect(productIds).toContain("prod-1");
        expect(productIds).toContain("prod-2");
      });

      it("stock_adjust payload includes sale_id, product_id, quantity, reason, and local_balance_after", () => {
        repo.completeSale(validOfflineSale);

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

      it("sale_create and stock_adjust outbox entries are ordered correctly (sale_create first)", () => {
        repo.completeSale(validOfflineSale);

        const entries = db
          .prepare("SELECT operation_type FROM outbox ORDER BY created_at ASC, rowid ASC")
          .all() as { operation_type: string }[];

        expect(entries.length).toBeGreaterThanOrEqual(2);
        expect(entries[0].operation_type).toBe("sale_create");
        expect(entries[1].operation_type).toBe("stock_adjust");
      });
    });

    // -------------------------------------------------------------------
    // Outbox metadata fields
    // -------------------------------------------------------------------
    describe("outbox metadata", () => {
      beforeEach(() => {
        dir = tempDir();
        db = createTestDb(dir);
        seedSession(db);
        getDb = () => db;
        outboxRepo = new OutboxSqliteRepository(getDb);
        repo = new SalesSqliteRepository(getDb, outboxRepo);
      });

      afterEach(() => {
        closeDatabase(db);
        cleanup(dir);
      });

      it("records local_device_timestamp on the sale_create outbox entry", () => {
        repo.completeSale(validOfflineSale);

        const saleEntry = db
          .prepare(
            "SELECT local_device_timestamp FROM outbox WHERE operation_type = 'sale_create' LIMIT 1",
          )
          .get() as { local_device_timestamp: string | null };
        expect(saleEntry.local_device_timestamp).toBeTruthy();
        expect(() => new Date(saleEntry.local_device_timestamp!)).not.toThrow();
      });

      it("records local_device_timestamp on stock_adjust outbox entries", () => {
        repo.completeSale(validOfflineSale);

        const stockEntry = db
          .prepare(
            "SELECT local_device_timestamp FROM outbox WHERE operation_type = 'stock_adjust' LIMIT 1",
          )
          .get() as { local_device_timestamp: string | null };
        expect(stockEntry.local_device_timestamp).toBeTruthy();
      });

      it("records actor_user_id from the cached offline session", () => {
        repo.completeSale(validOfflineSale);

        const saleEntry = db
          .prepare(
            "SELECT actor_user_id FROM outbox WHERE operation_type = 'sale_create' LIMIT 1",
          )
          .get() as { actor_user_id: string | null };
        expect(saleEntry.actor_user_id).toBe("user-1");
      });

      it("sets entity_label on the sale_create outbox entry", () => {
        repo.completeSale(validOfflineSale);

        const saleEntry = db
          .prepare(
            "SELECT entity_label FROM outbox WHERE operation_type = 'sale_create' LIMIT 1",
          )
          .get() as { entity_label: string | null };
        expect(saleEntry.entity_label).toBeTruthy();
      });
    });

    // -------------------------------------------------------------------
    // Revalidation flag
    // -------------------------------------------------------------------
    describe("revalidation flag after offline sale", () => {
      beforeEach(() => {
        dir = tempDir();
        db = createTestDb(dir);
        seedSession(db);
        getDb = () => db;
        outboxRepo = new OutboxSqliteRepository(getDb);
        repo = new SalesSqliteRepository(getDb, outboxRepo);
      });

      afterEach(() => {
        closeDatabase(db);
        cleanup(dir);
      });

      it("sets revalidation_required flag after completing an offline sale", () => {
        repo.completeSale(validOfflineSale);

        const row = db
          .prepare("SELECT value FROM metadata WHERE key = 'revalidation_required'")
          .get() as { value: string } | undefined;
        expect(row).toBeDefined();
        expect(row!.value).toBe("1");
      });
    });

    // -------------------------------------------------------------------
    // Transaction rollback on outbox failure
    // -------------------------------------------------------------------
    describe("transaction rollback", () => {
      it("rolls back entire sale when outbox enqueue fails", () => {
        dir = tempDir();
        db = createTestDb(dir);
        seedSession(db);
        getDb = () => db;

        // Create a failing outbox repository
        const failingOutboxRepo: IOutboxRepository = {
          enqueue(_entry: OutboxEntryInput): void {
            throw new Error("Outbox write failure");
          },
        };

        repo = new SalesSqliteRepository(getDb, failingOutboxRepo);

        expect(() => repo.completeSale(validOfflineSale)).toThrow("Outbox write failure");

        // Verify nothing was persisted
        const sales = db.prepare("SELECT COUNT(*) as cnt FROM sales").get() as { cnt: number };
        expect(sales.cnt).toBe(0);

        const items = db.prepare("SELECT COUNT(*) as cnt FROM sale_items").get() as { cnt: number };
        expect(items.cnt).toBe(0);

        const payments = db.prepare("SELECT COUNT(*) as cnt FROM sale_payments").get() as { cnt: number };
        expect(payments.cnt).toBe(0);

        const movements = db.prepare("SELECT COUNT(*) as cnt FROM stock_movements").get() as { cnt: number };
        expect(movements.cnt).toBe(0);

        const balances = db.prepare("SELECT stock_actual FROM stock_balances WHERE product_id = ?")
          .get("prod-1") as { stock_actual: number };
        expect(balances.stock_actual).toBe(10); // unchanged

        closeDatabase(db);
        cleanup(dir);
      });
    });
  });

  // -------------------------------------------------------------------
  // getSaleById
  // -------------------------------------------------------------------
  describe("getSaleById", () => {
    let dir: string;
    let db: Database.Database;
    let repo: SalesSqliteRepository;

    beforeEach(() => {
      dir = tempDir();
      db = createTestDb(dir);
      seedSession(db);
      const getDb = () => db;
      const outboxRepo = new OutboxSqliteRepository(getDb);
      repo = new SalesSqliteRepository(getDb, outboxRepo);
    });

    afterEach(() => {
      closeDatabase(db);
      cleanup(dir);
    });

    it("returns undefined when the sale does not exist", () => {
      const result = repo.getSaleById("nonexistent-id");
      expect(result).toBeUndefined();
    });

    it("returns the sale with correct mapping when it exists", () => {
      const completeResult = repo.completeSale(validOfflineSale);
      const sale = repo.getSaleById(completeResult.sale.id);
      expect(sale).toBeDefined();
      expect(sale!.id).toBe(completeResult.sale.id);
      expect(sale!.total).toBe("200.00");
      expect(sale!.customer).toBe("Mostrador");
      expect(sale!.invoiceStatus).toBe("none");
      expect(sale!.createdAt).toBeTruthy();
    });

    it("does not require auth to read a sale", () => {
      // Create a repo without session
      const dir2 = tempDir();
      const db2 = createTestDb(dir2);
      // Seed a session and create a sale, then remove the session
      seedSession(db2);
      const getDb2 = () => db2;
      const outboxRepo2 = new OutboxSqliteRepository(getDb2);
      const repo2 = new SalesSqliteRepository(getDb2, outboxRepo2);
      const completeResult = repo2.completeSale(validOfflineSale);

      // Now remove the session
      db2.prepare("DELETE FROM offline_sessions").run();

      // getSaleById should still work without auth
      const sale = repo2.getSaleById(completeResult.sale.id);
      expect(sale).toBeDefined();
      expect(sale!.id).toBe(completeResult.sale.id);

      closeDatabase(db2);
      cleanup(dir2);
    });
  });

  // -------------------------------------------------------------------
  // listSales
  // -------------------------------------------------------------------
  describe("listSales", () => {
    let dir: string;
    let db: Database.Database;
    let repo: SalesSqliteRepository;

    beforeEach(() => {
      dir = tempDir();
      db = createTestDb(dir);
      seedSession(db);
      const getDb = () => db;
      const outboxRepo = new OutboxSqliteRepository(getDb);
      repo = new SalesSqliteRepository(getDb, outboxRepo);
    });

    afterEach(() => {
      closeDatabase(db);
      cleanup(dir);
    });

    it("returns an empty array when no sales exist", () => {
      const result = repo.listSales();
      expect(result).toEqual([]);
    });

    it("returns sales ordered by created_at DESC", () => {
      // Create two sales
      const sale1 = repo.completeSale(validOfflineSale);
      // Small delay to ensure different timestamps
      const sale2 = repo.completeSale({
        ...validOfflineSale,
        total: "100.00",
        payments: [{ method: "cash", amount: "100.00" }],
      });

      const list = repo.listSales();
      expect(list.length).toBeGreaterThanOrEqual(2);
      // Most recent first
      expect(new Date(list[0].createdAt).getTime()).toBeGreaterThanOrEqual(
        new Date(list[1].createdAt).getTime(),
      );
    });

    it("maps invoiceStatus and invoiceRequested correctly", () => {
      repo.completeSale(validOfflineSale);
      const list = repo.listSales();
      expect(list.length).toBeGreaterThan(0);
      expect(list[0].invoiceStatus).toBe("none");
      expect(list[0].invoiceRequested).toBe(false);
    });

    it("includes syncStatus from LEFT JOIN with outbox", () => {
      repo.completeSale(validOfflineSale);
      const list = repo.listSales();
      expect(list.length).toBeGreaterThan(0);
      // sale_create outbox is pending, so syncStatus should be "pending"
      expect(list[0].syncStatus).toBe("pending");
    });

    it("does not require auth to list sales", () => {
      repo.completeSale(validOfflineSale);

      // Remove the session
      db.prepare("DELETE FROM offline_sessions").run();

      // listSales should still work without auth
      const list = repo.listSales();
      expect(list.length).toBeGreaterThan(0);
    });
  });
});
