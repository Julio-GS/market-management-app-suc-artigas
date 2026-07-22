import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
      _handlers: handlers,
    },
  };
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { getDatabasePath, openDatabase, closeDatabase, runMigrations } from "./db";
import { PRODUCTS_CHANNELS, registerProductsIpc, unregisterProductsIpc } from "./products-ipc";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-products-ipc-test-"));
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
    VALUES ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
  `).run();
  return db;
}

describe("products-ipc runtime validation", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
    registerProductsIpc(() => db);
  });

  afterEach(() => {
    try {
      unregisterProductsIpc();
    } catch {
      // already removed
    }
    closeDatabase(db);
    cleanup(dir);
    vi.clearAllMocks();
  });

  async function getHandler(channel: string) {
    const { ipcMain } = await import("electron");
    const mockIpc = ipcMain as unknown as {
      _handlers: Map<string, (...args: unknown[]) => unknown>;
    };
    const handler = mockIpc._handlers.get(channel);
    expect(handler).toBeTypeOf("function");
    return handler!;
  }

  it("rejects invalid create payloads before touching the database", async () => {
    const handler = await getHandler(PRODUCTS_CHANNELS.CREATE);

    const result = handler({}, { detalle: "", codigos: [123] }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("detalle");

    const count = db.prepare("SELECT COUNT(*) as count FROM products").get() as { count: number };
    expect(count.count).toBe(0);
  });

  it("rejects invalid update payloads before mutating the product", async () => {
    db.prepare(`
      INSERT INTO products
        (id, detalle, costo_neto, costo_final, iva, cambio_costo, cambio_precio,
         etiqueta, facturable, maneja_stock, codigos, pricing_mode, is_protected,
         created_at, updated_at)
      VALUES
        ('prod-1', 'Yerba', NULL, '10.00', NULL, 'fixed', 'fixed',
         '', 1, 1, '["YER-1"]', 'fixed', 0, '2026-07-01', '2026-07-01')
    `).run();

    const handler = await getHandler(PRODUCTS_CHANNELS.UPDATE);
    const result = handler({}, "prod-1", { detalle: 42, codigos: ["OK", "   "] }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("detalle");

    const row = db.prepare("SELECT detalle, codigos FROM products WHERE id = 'prod-1'").get() as {
      detalle: string;
      codigos: string;
    };
    expect(row.detalle).toBe("Yerba");
    expect(row.codigos).toBe('["YER-1"]');
  });

  it("rejects invalid barcode lookup payloads", async () => {
    const handler = await getHandler(PRODUCTS_CHANNELS.FIND_BY_CODE);

    const result = handler({}, { code: "BAD" }) as { success: boolean; error?: string; errorCode?: string };

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INVALID_INPUT");
    expect(result.error).toContain("code");
  });

  it("rejects invalid list filter payloads", async () => {
    const handler = await getHandler(PRODUCTS_CHANNELS.LIST);

    const result = handler({}, { search: 42 }) as Array<{ success: boolean; error?: string }>;

    expect(result).toHaveLength(1);
    expect(result[0].success).toBe(false);
    expect(result[0].error).toContain("search");
  });

  it("accepts valid create payloads and sanitizes barcode strings", async () => {
    const handler = await getHandler(PRODUCTS_CHANNELS.CREATE);
    const result = handler({}, {
      detalle: "Azucar",
      codigos: ["  AZ-1  ", "AZ-1", "", "   ", "779123"],
      facturable: true,
      maneja_stock: true,
    }) as {
      success: boolean;
      product?: { detalle: string; codigos: string[] };
    };

    expect(result.success).toBe(true);
    expect(result.product?.detalle).toBe("Azucar");
    expect(result.product?.codigos).toEqual(["AZ-1", "779123"]);
  });
});
