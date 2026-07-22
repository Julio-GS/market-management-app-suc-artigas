// ---------------------------------------------------------------------------
// Infrastructure: ProductsSqliteRepository integration tests
//
// Migrated from src/main/products-local.test.ts to exercise the new
// production-path repository (ProductsSqliteRepository + OutboxSqliteRepository).
// Preserves the same SQLite-backed assertions: search, shape mapping, codigos
// sanitization, findByCode, and outbox transaction semantics.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { getDatabasePath, openDatabase, closeDatabase, runMigrations } from "../../db";
import { ProductsSqliteRepository } from "./products-sqlite-repository";
import { OutboxSqliteRepository } from "./outbox-sqlite-repository";
import type { IOutboxRepository } from "../../ports/outbox-repository";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-products-repo-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createTestDb(dir: string): Database.Database {
  const dbPath = getDatabasePath(dir);
  const db = openDatabase(dbPath);
  runMigrations(db);

  db.prepare(`
    INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
    VALUES ('user-1', 'cashier1', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `).run();

  // Seed products with varied names and codes for search/findByCode tests
  db.prepare(`
    INSERT OR REPLACE INTO products
      (id, detalle, costo_neto, costo_final, iva, cambio_costo, cambio_precio,
       etiqueta, facturable, maneja_stock, codigos, pricing_mode, is_protected,
       created_at, updated_at)
    VALUES
      ('prod-1', 'Leche Entera 1L', NULL, '120.00', NULL, 'fixed', 'fixed',
       '', 1, 1, '["LEC-0001","77912340001"]', 'fixed', 0, '2026-01-01', '2026-01-01'),
      ('prod-2', 'Pan Frances', NULL, '80.00', NULL, 'fixed', 'fixed',
       '', 1, 1, '["PAN-0001"]', 'fixed', 0, '2026-01-01', '2026-01-01'),
      ('prod-3', 'Queso Cremoso', NULL, '250.00', NULL, 'fixed', 'fixed',
       '', 1, 1, '["QUE-0001","77980002"]', 'fixed', 0, '2026-01-01', '2026-01-01'),
      ('prod-4', 'Yogur Entero', NULL, '95.00', NULL, 'fixed', 'fixed',
       '', 1, 0, '["YOG-0001"]', 'fixed', 0, '2026-01-01', '2026-01-01')
  `).run();
  return db;
}

describe("ProductsSqliteRepository", () => {
  let dir: string;
  let db: Database.Database;
  let outboxRepo: IOutboxRepository;
  let productsRepo: ProductsSqliteRepository;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
    outboxRepo = new OutboxSqliteRepository(() => db);
    productsRepo = new ProductsSqliteRepository(() => db, outboxRepo);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  // -----------------------------------------------------------------------
  // Search / list
  // -----------------------------------------------------------------------

  describe("list (no filters)", () => {
    it("returns all products when no search filter is provided", () => {
      const results = productsRepo.list();
      expect(results).toHaveLength(4);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it("returns results ordered by detalle ASC", () => {
      const results = productsRepo.list();
      const names = results.map((r) => r.product!.detalle);
      expect(names).toEqual(["Leche Entera 1L", "Pan Frances", "Queso Cremoso", "Yogur Entero"]);
    });
  });

  describe("search", () => {
    it("returns products whose detalle matches the search term (case-insensitive LIKE)", () => {
      const results = productsRepo.search({ search: "leche" });
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].product!.detalle).toBe("Leche Entera 1L");
    });

    it("returns products matching partial word (substring search)", () => {
      const results = productsRepo.search({ search: "queso" });
      expect(results).toHaveLength(1);
      expect(results[0].product!.detalle).toBe("Queso Cremoso");
    });

    it("returns products whose codigos JSON array contains the search term", () => {
      const results = productsRepo.search({ search: "77912340001" });
      expect(results).toHaveLength(1);
      expect(results[0].product!.detalle).toBe("Leche Entera 1L");
    });

    it("returns empty array when no products match the search term", () => {
      const results = productsRepo.search({ search: "nonexistent" });
      expect(results).toHaveLength(0);
    });

    it("returns multiple products when search matches more than one", () => {
      const results = productsRepo.search({ search: "ent" });
      expect(results).toHaveLength(2);
      const names = results.map((r) => r.product!.detalle).sort();
      expect(names).toEqual(["Leche Entera 1L", "Yogur Entero"]);
    });
  });

  describe("result shape mapping", () => {
    it("maps all OfflineProductRow fields to OfflineProductResult shape", () => {
      const results = productsRepo.search({ search: "leche" });
      expect(results).toHaveLength(1);
      const product = results[0].product!;
      expect(product.id).toBe("prod-1");
      expect(product.detalle).toBe("Leche Entera 1L");
      expect(product.codigos).toEqual(["LEC-0001", "77912340001"]);
      expect(product.facturable).toBe(true);
      expect(product.manejaStock).toBe(true);
      expect(product.pricingMode).toBe("fixed");
      expect(product.costoNeto).toBeNull();
      expect(product.costoFinal).toBe("120.00");
      expect(product.iva).toBeNull();
      expect(product.cambioCosto).toBe("fixed");
      expect(product.cambioPrecio).toBe("fixed");
      expect(product.etiqueta).toBe("");
      expect(product.createdAt).toBe("2026-01-01");
      expect(product.updatedAt).toBe("2026-01-01");
    });

    it("does NOT expose isProtected in the result shape (legacy contract preservation)", () => {
      const results = productsRepo.list();
      for (const r of results) {
        expect(r.product).toBeDefined();
        // isProtected must NOT be present in the response shape
        expect((r.product as Record<string, unknown>).isProtected).toBeUndefined();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Mutation + sanitization
  // -----------------------------------------------------------------------

  describe("product mutation sanitization", () => {
    it("sanitizes codigos before persisting newly created products", () => {
      const result = productsRepo.create({
        detalle: "Azucar",
        codigos: ["  AZ-1  ", "", "AZ-1", "779123", "   "],
      });

      expect(result.success).toBe(true);
      expect(result.product?.codigos).toEqual(["AZ-1", "779123"]);

      const row = db
        .prepare("SELECT codigos FROM products WHERE id = ?")
        .get(result.product!.id) as { codigos: string };
      expect(row.codigos).toBe('["AZ-1","779123"]');
    });

    it("sanitizes codigos before persisting product updates", () => {
      const result = productsRepo.update("prod-2", {
        codigos: ["  PAN-2  ", "PAN-2", "", "   ", "7790002"],
      });

      expect(result.success).toBe(true);
      expect(result.product?.codigos).toEqual(["PAN-2", "7790002"]);

      const row = db
        .prepare("SELECT codigos FROM products WHERE id = 'prod-2'")
        .get() as { codigos: string };
      expect(row.codigos).toBe('["PAN-2","7790002"]');
    });
  });

  // -----------------------------------------------------------------------
  // findByCode
  // -----------------------------------------------------------------------

  describe("findByCode", () => {
    it("returns the product matching the exact code in codigos array", () => {
      const result = productsRepo.findByCode("LEC-0001");
      expect(result.success).toBe(true);
      expect(result.product!.detalle).toBe("Leche Entera 1L");
      expect(result.product!.codigos).toContain("LEC-0001");
    });

    it("finds a product by its second barcode", () => {
      const result = productsRepo.findByCode("77980002");
      expect(result.success).toBe(true);
      expect(result.product!.detalle).toBe("Queso Cremoso");
    });

    it("returns success:false when no product has the given code", () => {
      const result = productsRepo.findByCode("NONEXISTENT-CODE");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Product not found by code");
    });

    it("returns full product shape including all mapped fields", () => {
      const result = productsRepo.findByCode("PAN-0001");
      expect(result.success).toBe(true);
      expect(result.product!.id).toBe("prod-2");
      expect(result.product!.detalle).toBe("Pan Frances");
      expect(result.product!.codigos).toEqual(["PAN-0001"]);
      expect(result.product!.manejaStock).toBe(true);
      expect(result.product!.facturable).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // get
  // -----------------------------------------------------------------------

  describe("get", () => {
    it("returns product by ID", () => {
      const result = productsRepo.get("prod-1");
      expect(result.success).toBe(true);
      expect(result.product!.detalle).toBe("Leche Entera 1L");
    });

    it("returns success:false for non-existent product", () => {
      const result = productsRepo.get("nonexistent");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Product not found");
    });
  });

  // -----------------------------------------------------------------------
  // Create
  // -----------------------------------------------------------------------

  describe("create", () => {
    it("creates a product and returns the mapped result", () => {
      const result = productsRepo.create({
        detalle: "New Product",
        costo_neto: "50.00",
        facturable: true,
        maneja_stock: true,
        codigos: ["CODE-001"],
      });

      expect(result.success).toBe(true);
      expect(result.product!.detalle).toBe("New Product");
      expect(result.product!.costoNeto).toBe("50.00");
      expect(result.product!.facturable).toBe(true);
      expect(result.product!.manejaStock).toBe(true);
      expect(result.product!.codigos).toEqual(["CODE-001"]);
      expect(result.product!.pricingMode).toBe("fixed");
    });

    it("enqueues an outbox row for the created product", () => {
      const beforeCount = (db.prepare("SELECT COUNT(*) AS cnt FROM outbox").get() as { cnt: number }).cnt;

      productsRepo.create({ detalle: "Outbox Test" });

      const afterCount = (db.prepare("SELECT COUNT(*) AS cnt FROM outbox").get() as { cnt: number }).cnt;
      expect(afterCount).toBe(beforeCount + 1);

      const outboxRow = db.prepare("SELECT * FROM outbox ORDER BY created_at DESC LIMIT 1").get() as {
        operation_type: string;
        aggregate_type: string;
        status: string;
      };
      expect(outboxRow.operation_type).toBe("product_create");
      expect(outboxRow.aggregate_type).toBe("product");
      expect(outboxRow.status).toBe("pending");
    });
  });

  // -----------------------------------------------------------------------
  // Update
  // -----------------------------------------------------------------------

  describe("update", () => {
    it("updates a product and returns the mapped result", () => {
      const result = productsRepo.update("prod-1", {
        detalle: "Leche Entera 1L Updated",
        costo_neto: "130.00",
      });

      expect(result.success).toBe(true);
      expect(result.product!.detalle).toBe("Leche Entera 1L Updated");
      expect(result.product!.costoNeto).toBe("130.00");
    });

    it("returns success:false when product does not exist", () => {
      const result = productsRepo.update("nonexistent", { detalle: "Nope" });
      expect(result.success).toBe(false);
      expect(result.error).toBe("Product not found");
    });

    it("enqueues an outbox row for the updated product", () => {
      const beforeCount = (db.prepare("SELECT COUNT(*) AS cnt FROM outbox").get() as { cnt: number }).cnt;

      productsRepo.update("prod-2", { detalle: "Pan Updated" });

      const afterCount = (db.prepare("SELECT COUNT(*) AS cnt FROM outbox").get() as { cnt: number }).cnt;
      expect(afterCount).toBe(beforeCount + 1);
    });
  });

  // -----------------------------------------------------------------------
  // Delete
  // -----------------------------------------------------------------------

  describe("delete", () => {
    it("deletes a non-protected product", () => {
      const result = productsRepo.delete("prod-4");
      expect(result.success).toBe(true);

      const exists = db.prepare("SELECT id FROM products WHERE id = 'prod-4'").get();
      expect(exists).toBeUndefined();
    });

    it("rejects deletion of a protected product with PROTECTED_PRODUCT errorCode", () => {
      // Make prod-1 protected
      db.prepare("UPDATE products SET is_protected = 1 WHERE id = 'prod-1'").run();

      const result = productsRepo.delete("prod-1");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Cannot delete a protected product");
      expect(result.errorCode).toBe("PROTECTED_PRODUCT");

      // Product should still exist
      const exists = db.prepare("SELECT id FROM products WHERE id = 'prod-1'").get();
      expect(exists).toBeDefined();
    });

    it("returns success:false when product does not exist", () => {
      const result = productsRepo.delete("nonexistent");
      expect(result.success).toBe(false);
      expect(result.error).toBe("Product not found");
    });

    it("enqueues an outbox row for the deleted product", () => {
      const beforeCount = (db.prepare("SELECT COUNT(*) AS cnt FROM outbox").get() as { cnt: number }).cnt;

      productsRepo.delete("prod-3");

      const afterCount = (db.prepare("SELECT COUNT(*) AS cnt FROM outbox").get() as { cnt: number }).cnt;
      expect(afterCount).toBe(beforeCount + 1);
    });
  });

  // -----------------------------------------------------------------------
  // Transaction rollback behavior
  // -----------------------------------------------------------------------

  describe("transaction rollback", () => {
    it("rolls back product write when outbox enqueue fails", () => {
      // Create a repo with an outbox that always throws
      const failingOutbox: IOutboxRepository = {
        enqueue: () => { throw new Error("Simulated outbox failure"); },
      };
      const repo = new ProductsSqliteRepository(() => db, failingOutbox);

      const beforeCount = (db.prepare("SELECT COUNT(*) AS cnt FROM products").get() as { cnt: number }).cnt;

      expect(() => repo.create({ detalle: "Rollback Test" })).toThrow();

      // Product count should be unchanged after rollback
      const afterCount = (db.prepare("SELECT COUNT(*) AS cnt FROM products").get() as { cnt: number }).cnt;
      expect(afterCount).toBe(beforeCount);
    });
  });
});
