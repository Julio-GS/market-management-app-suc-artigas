import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock Electron's ipcMain so IPC handler registration works in vitest
// ---------------------------------------------------------------------------

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
      // Expose for tests
      _handlers: handlers,
    },
  };
});

import Database from "better-sqlite3";
import {
  registerSalesIpc,
  unregisterSalesIpc,
  SALES_CHANNELS,
  validateSaleInput,
} from "./sales-ipc";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY,
      total TEXT NOT NULL,
      customer TEXT NOT NULL DEFAULT 'Mostrador',
      invoice_status TEXT NOT NULL DEFAULT 'none',
      invoice_requested INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sale_items (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id),
      product_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      quantity REAL NOT NULL,
      unit_price TEXT NOT NULL,
      subtotal TEXT NOT NULL,
      discount_amount TEXT NOT NULL DEFAULT '0.00',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sale_payments (
      id TEXT PRIMARY KEY,
      sale_id TEXT NOT NULL REFERENCES sales(id),
      method TEXT NOT NULL,
      amount TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stock_balances (
      product_id TEXT PRIMARY KEY,
      stock_actual REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      quantity REAL NOT NULL,
      reason TEXT NOT NULL,
      sale_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      idempotency_key TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT,
      server_result TEXT,
      next_retry_at TEXT,
      synced_at TEXT
    );
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      maneja_stock INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    INSERT OR IGNORE INTO metadata (key, value) VALUES ('installation_id', 'test-install');
  `);
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sales-ipc registration seam", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createMockDb();
  });

  afterEach(() => {
    try {
      unregisterSalesIpc();
    } catch {
      // May already be unregistered
    }
    db.close();
    vi.clearAllMocks();
  });

  it("registerSalesIpc and unregisterSalesIpc are callable functions", () => {
    expect(registerSalesIpc).toBeTypeOf("function");
    expect(unregisterSalesIpc).toBeTypeOf("function");
  });

  it("registerSalesIpc succeeds with a valid db getter", () => {
    expect(() => registerSalesIpc(() => db)).not.toThrow();
  });

  it("unregisterSalesIpc succeeds after registration", () => {
    registerSalesIpc(() => db);
    expect(() => unregisterSalesIpc()).not.toThrow();
  });

  it("register -> unregister -> register cycle is safe", () => {
    registerSalesIpc(() => db);
    unregisterSalesIpc();
    // Re-registering after unregister should work (no duplicate handler errors)
    expect(() => registerSalesIpc(() => db)).not.toThrow();
    unregisterSalesIpc();
  });

  it("SALES_CHANNELS match the preload contract", () => {
    // The preload/index.ts file uses these exact channel names via
    // ipcRenderer.invoke(). This test acts as a contract test between
    // main-process sales-ipc.ts and preload/index.ts.
    expect(SALES_CHANNELS.COMPLETE_SALE).toBe("offline:sales:complete");
    expect(SALES_CHANNELS.GET_SALE).toBe("offline:sales:get");
  });

  it("registers IPC handlers on the expected channels", async () => {
    const { ipcMain } = await import("electron");

    registerSalesIpc(() => db);

    // Verify ipcMain.handle was called for both channels
    expect(ipcMain.handle).toHaveBeenCalledWith(
      "offline:sales:complete",
      expect.any(Function),
    );
    expect(ipcMain.handle).toHaveBeenCalledWith(
      "offline:sales:get",
      expect.any(Function),
    );
  });

  it("unregisterSalesIpc removes both IPC handlers", async () => {
    const { ipcMain } = await import("electron");

    registerSalesIpc(() => db);
    unregisterSalesIpc();

    expect(ipcMain.removeHandler).toHaveBeenCalledWith(
      "offline:sales:complete",
    );
    expect(ipcMain.removeHandler).toHaveBeenCalledWith("offline:sales:get");
  });
});

describe("validateSaleInput -- IPC boundary validation", () => {
  it("accepts a valid minimal sale input", () => {
    const result = validateSaleInput({
      items: [{ productId: "p1", name: "Test", quantity: 1, unitPrice: "10", subtotal: "10", discountAmount: "0" }],
      payments: [{ method: "cash", amount: "10" }],
      total: "10.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.items).toHaveLength(1);
    }
  });

  it("rejects null / non-object input", () => {
    expect(validateSaleInput(null).valid).toBe(false);
    expect(validateSaleInput(undefined).valid).toBe(false);
    expect(validateSaleInput("string").valid).toBe(false);
    expect(validateSaleInput(42).valid).toBe(false);
  });

  it("rejects input with no items", () => {
    const result = validateSaleInput({
      items: [],
      payments: [{ method: "cash", amount: "10" }],
      total: "10.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("item");
  });

  it("rejects item with invalid productId", () => {
    const result = validateSaleInput({
      items: [{ productId: "", name: "X", quantity: 1, unitPrice: "1", subtotal: "1", discountAmount: "0" }],
      payments: [{ method: "cash", amount: "1" }],
      total: "1.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects item with non-positive quantity", () => {
    const result = validateSaleInput({
      items: [{ productId: "p1", name: "X", quantity: 0, unitPrice: "1", subtotal: "1", discountAmount: "0" }],
      payments: [{ method: "cash", amount: "1" }],
      total: "1.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects input with no payments", () => {
    const result = validateSaleInput({
      items: [{ productId: "p1", name: "X", quantity: 1, unitPrice: "1", subtotal: "1", discountAmount: "0" }],
      payments: [],
      total: "1.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("payment");
  });

  it("rejects payment with empty method", () => {
    const result = validateSaleInput({
      items: [{ productId: "p1", name: "X", quantity: 1, unitPrice: "1", subtotal: "1", discountAmount: "0" }],
      payments: [{ method: "", amount: "1" }],
      total: "1.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects missing total", () => {
    const result = validateSaleInput({
      items: [{ productId: "p1", name: "X", quantity: 1, unitPrice: "1", subtotal: "1", discountAmount: "0" }],
      payments: [{ method: "cash", amount: "1" }],
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects non-boolean invoiceRequested", () => {
    const result = validateSaleInput({
      items: [{ productId: "p1", name: "X", quantity: 1, unitPrice: "1", subtotal: "1", discountAmount: "0" }],
      payments: [{ method: "cash", amount: "1" }],
      total: "1.00",
      invoiceRequested: "yes" as unknown as boolean,
    });
    expect(result.valid).toBe(false);
  });
});
