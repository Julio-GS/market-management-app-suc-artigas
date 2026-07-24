import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyServerProductPayload,
  restoreProductFromSnapshot,
} from "./product-payload";

// ---------------------------------------------------------------------------
// Slice 3 RED — this test must FAIL because product-payload.ts does not exist.
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prod-payload-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("product-payload", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = tempDir();
    const dbPath = path.join(dir, "test.db");
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        detalle TEXT DEFAULT '',
        costo_neto TEXT,
        costo_final TEXT,
        iva TEXT,
        cambio_costo TEXT DEFAULT 'fixed',
        cambio_precio TEXT DEFAULT 'fixed',
        etiqueta TEXT DEFAULT '',
        facturable INTEGER DEFAULT 1,
        maneja_stock INTEGER DEFAULT 1,
        codigos TEXT DEFAULT '[]',
        pricing_mode TEXT DEFAULT 'fixed',
        is_protected INTEGER DEFAULT 0,
        created_at TEXT,
        updated_at TEXT
      )
    `);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    cleanup(dir);
  });

  // -----------------------------------------------------------------------
  // applyServerProductPayload
  // -----------------------------------------------------------------------

  describe("applyServerProductPayload", () => {
    it("inserts a new product when it does not exist locally", () => {
      applyServerProductPayload(db, {
        id: "prod-new",
        detalle: "New Product",
        costo_neto: "100",
        facturable: true,
        maneja_stock: false,
      });

      const row = db.prepare("SELECT * FROM products WHERE id = 'prod-new'").get() as Record<string, unknown>;
      expect(row).toBeTruthy();
      expect(row.detalle).toBe("New Product");
      expect(row.costo_neto).toBe("100");
      expect(row.facturable).toBe(1);
      expect(row.maneja_stock).toBe(0);
    });

    it("updates only provided fields when product exists", () => {
      db.prepare(`INSERT INTO products (id, detalle, costo_neto, costo_final)
        VALUES ('prod-exists', 'Old Name', '50', '75')`).run();

      applyServerProductPayload(db, {
        id: "prod-exists",
        detalle: "Updated Name",
        // costo_neto NOT provided — should stay '50'
      });

      const row = db.prepare("SELECT * FROM products WHERE id = 'prod-exists'").get() as Record<string, unknown>;
      expect(row.detalle).toBe("Updated Name");
      expect(row.costo_neto).toBe("50");   // unchanged
      expect(row.costo_final).toBe("75");   // unchanged
    });

    it("converts boolean fields to 1/0", () => {
      applyServerProductPayload(db, {
        id: "prod-bool",
        detalle: "Bool Test",
        facturable: false,
        maneja_stock: true,
        is_protected: true,
      });

      const row = db.prepare("SELECT * FROM products WHERE id = 'prod-bool'").get() as Record<string, unknown>;
      expect(row.facturable).toBe(0);
      expect(row.maneja_stock).toBe(1);
      expect(row.is_protected).toBe(1);
    });

    it("JSON-stringifies codigos", () => {
      applyServerProductPayload(db, {
        id: "prod-codes",
        detalle: "Codes",
        codigos: ["ABC", "DEF"],
      });

      const row = db.prepare("SELECT * FROM products WHERE id = 'prod-codes'").get() as Record<string, unknown>;
      expect(JSON.parse(row.codigos as string)).toEqual(["ABC", "DEF"]);
    });

    it("skips when id is missing", () => {
      applyServerProductPayload(db, { detalle: "No ID" });
      const count = db.prepare("SELECT COUNT(*) as c FROM products").get() as { c: number };
      expect(count.c).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // restoreProductFromSnapshot
  // -----------------------------------------------------------------------

  describe("restoreProductFromSnapshot", () => {
    it("inserts a product from snapshot when it does not exist", () => {
      restoreProductFromSnapshot(db, {
        id: "prod-restore",
        detalle: "Restored Product",
        costo_neto: "200",
        facturable: true,
      });

      const row = db.prepare("SELECT * FROM products WHERE id = 'prod-restore'").get() as Record<string, unknown>;
      expect(row).toBeTruthy();
      expect(row.detalle).toBe("Restored Product");
      expect(row.costo_neto).toBe("200");
    });

    it("does not overwrite existing product during restore", () => {
      db.prepare(`INSERT INTO products (id, detalle, costo_neto)
        VALUES ('prod-exists-2', 'Existing', '300')`).run();

      restoreProductFromSnapshot(db, {
        id: "prod-exists-2",
        detalle: "Should Not Overwrite",
      });

      const row = db.prepare("SELECT * FROM products WHERE id = 'prod-exists-2'").get() as Record<string, unknown>;
      expect(row.detalle).toBe("Existing");
    });

    it("supports camelCase snapshot keys (costoNeto, cambioCosto, manejaStock, etc.)", () => {
      restoreProductFromSnapshot(db, {
        id: "prod-camel",
        detalle: "CamelCase Product",
        costoNeto: "150",
        costoFinal: "180",
        cambioCosto: "formula",
        cambioPrecio: "formula",
        manejaStock: false,
        pricingMode: "formula",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      });

      const row = db.prepare("SELECT * FROM products WHERE id = 'prod-camel'").get() as Record<string, unknown>;
      expect(row).toBeTruthy();
      expect(row.costo_neto).toBe("150");
      expect(row.costo_final).toBe("180");
      expect(row.cambio_costo).toBe("formula");
      expect(row.cambio_precio).toBe("formula");
      expect(row.maneja_stock).toBe(0);
      expect(row.pricing_mode).toBe("formula");
    });

    it("skips restore when snapshot has no id", () => {
      restoreProductFromSnapshot(db, { detalle: "Missing ID" });
      const count = db.prepare("SELECT COUNT(*) as c FROM products").get() as { c: number };
      expect(count.c).toBe(0);
    });
  });
});
