import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { getDatabasePath, openDatabase, closeDatabase, runMigrations } from "./db";
import {
  createOfflineProduct,
  updateOfflineProduct,
  searchOfflineProducts,
  findOfflineProductByCode,
} from "./products-local";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-products-test-"));
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

describe("searchOfflineProducts", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  describe("without filters", () => {
    it("returns all products when no search filter is provided", () => {
      const results = searchOfflineProducts(db);
      expect(results).toHaveLength(4);
      expect(results.every((r) => r.success)).toBe(true);
    });

    it("returns results ordered by detalle ASC", () => {
      const results = searchOfflineProducts(db);
      const names = results.map((r) => r.product!.detalle);
      expect(names).toEqual(["Leche Entera 1L", "Pan Frances", "Queso Cremoso", "Yogur Entero"]);
    });
  });

  describe("with search filter", () => {
    it("returns products whose detalle matches the search term (case-insensitive LIKE)", () => {
      const results = searchOfflineProducts(db, { search: "leche" });
      expect(results).toHaveLength(1);
      expect(results[0].success).toBe(true);
      expect(results[0].product!.detalle).toBe("Leche Entera 1L");
    });

    it("returns products matching partial word (substring search)", () => {
      const results = searchOfflineProducts(db, { search: "queso" });
      expect(results).toHaveLength(1);
      expect(results[0].product!.detalle).toBe("Queso Cremoso");
    });

    it("returns products whose codigos JSON array contains the search term", () => {
      // Search by barcode that matches a product's codigos
      const results = searchOfflineProducts(db, { search: "77912340001" });
      expect(results).toHaveLength(1);
      expect(results[0].product!.detalle).toBe("Leche Entera 1L");
    });

    it("returns empty array when no products match the search term", () => {
      const results = searchOfflineProducts(db, { search: "nonexistent" });
      expect(results).toHaveLength(0);
    });

    it("returns multiple products when search matches more than one", () => {
      // "entero" appears in both "Leche Entera 1L" and "Yogur Entero"
      const results = searchOfflineProducts(db, { search: "entero" });
      expect(results).toHaveLength(2);
      const names = results.map((r) => r.product!.detalle).sort();
      expect(names).toEqual(["Leche Entera 1L", "Yogur Entero"]);
    });
  });

  describe("result shape", () => {
    it("maps all OfflineProductRow fields to OfflineProductResult shape", () => {
      const results = searchOfflineProducts(db, { search: "leche" });
      expect(results).toHaveLength(1);
      const product = results[0].product!;
      expect(product.id).toBe("prod-1");
      expect(product.detalle).toBe("Leche Entera 1L");
      expect(product.codigos).toEqual(["LEC-0001", "77912340001"]);
      expect(product.facturable).toBe(true);
      expect(product.manejaStock).toBe(true);
      expect(product.pricingMode).toBe("fixed");
    });
  });
});

describe("product mutation sanitization", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("sanitizes codigos before persisting newly created products", () => {
    const result = createOfflineProduct(db, {
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
    const result = updateOfflineProduct(db, "prod-2", {
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

describe("findOfflineProductByCode", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("returns the product matching the exact code in codigos array", () => {
    const result = findOfflineProductByCode(db, "LEC-0001");
    expect(result.success).toBe(true);
    expect(result.product!.detalle).toBe("Leche Entera 1L");
    expect(result.product!.codigos).toContain("LEC-0001");
  });

  it("finds a product by its second barcode", () => {
    const result = findOfflineProductByCode(db, "77980002");
    expect(result.success).toBe(true);
    expect(result.product!.detalle).toBe("Queso Cremoso");
  });

  it("returns success:false when no product has the given code", () => {
    const result = findOfflineProductByCode(db, "NONEXISTENT-CODE");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Product not found by code");
  });

  it("returns full product shape including all mapped fields", () => {
    const result = findOfflineProductByCode(db, "PAN-0001");
    expect(result.success).toBe(true);
    expect(result.product!.id).toBe("prod-2");
    expect(result.product!.detalle).toBe("Pan Frances");
    expect(result.product!.codigos).toEqual(["PAN-0001"]);
    expect(result.product!.manejaStock).toBe(true);
    expect(result.product!.facturable).toBe(true);
  });
});
