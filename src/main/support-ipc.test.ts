import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock Electron's ipcMain so IPC handler registration works in vitest
// ---------------------------------------------------------------------------

vi.mock("electron", () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
      _handlers: handlers,
    },
  };
});

import { ipcMain } from "electron";
import {
  SUPPORT_CHANNELS,
  registerSupportIpc,
  unregisterSupportIpc,
} from "./support-ipc";

// ---------------------------------------------------------------------------
// Helper: create a minimal in-memory SQLite db with outbox table
// ---------------------------------------------------------------------------

import Database from "better-sqlite3";

function createTestDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE outbox (
      id                 TEXT PRIMARY KEY,
      idempotency_key    TEXT NOT NULL UNIQUE,
      operation_type     TEXT NOT NULL,
      aggregate_type     TEXT NOT NULL,
      aggregate_id       TEXT NOT NULL,
      payload            TEXT NOT NULL,
      status             TEXT NOT NULL DEFAULT 'pending',
      base_server_version TEXT,
      actor_user_id      TEXT,
      attempt_count      INTEGER NOT NULL DEFAULT 0,
      next_retry_at      TEXT,
      last_error         TEXT,
      server_result      TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      synced_at          TEXT,
      local_device_timestamp TEXT,
      manual_fix_reason      TEXT,
      entity_label           TEXT
    );
    CREATE TABLE IF NOT EXISTS sales (
      id TEXT PRIMARY KEY, total TEXT NOT NULL, customer TEXT NOT NULL DEFAULT 'Mostrador',
      invoice_status TEXT NOT NULL DEFAULT 'none', invoice_requested INTEGER NOT NULL DEFAULT 0,
      cae TEXT, cae_vto TEXT, cbte_nro TEXT, cbte_tipo TEXT, pto_vta TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stock_movements (
      id TEXT PRIMARY KEY, product_id TEXT NOT NULL, quantity INTEGER NOT NULL,
      reason TEXT NOT NULL, sale_id TEXT, created_at TEXT NOT NULL
    );
  `);
  return db;
}

function seedOutboxEntries(db: Database.Database): void {
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO outbox (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, last_error, created_at, updated_at)
    VALUES (@id, @idempotency_key, @operation_type, @aggregate_type, @aggregate_id, @payload, @status, @last_error, @now, @now)
  `);

  insert.run({ id: "ob-1", idempotency_key: "ik-1", operation_type: "sale_create", aggregate_type: "sale", aggregate_id: "sale-1", payload: '{"total":"100"}', status: "failed", last_error: "Conflict: server version mismatch", now });
  insert.run({ id: "ob-2", idempotency_key: "ik-2", operation_type: "sale_create", aggregate_type: "sale", aggregate_id: "sale-2", payload: '{"total":"200"}', status: "pending", last_error: null, now });
  insert.run({ id: "ob-3", idempotency_key: "ik-3", operation_type: "product_update", aggregate_type: "product", aggregate_id: "prod-1", payload: '{"detalle":"Updated"}', status: "synced", last_error: null, now });
  insert.run({ id: "ob-4", idempotency_key: "ik-4", operation_type: "product_delete", aggregate_type: "product", aggregate_id: "prod-2", payload: '{}', status: "failed", last_error: "Server error: 500", now });
  insert.run({ id: "ob-5", idempotency_key: "ik-5", operation_type: "stock_adjust", aggregate_type: "stock", aggregate_id: "stock-prod-1", payload: '{"quantity":-3}', status: "retry_wait", last_error: "Network timeout", now });
}

describe("support-ipc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      unregisterSupportIpc();
    } catch {
      // already removed
    }
  });

  // -----------------------------------------------------------------------
  // Registration lifecycle
  // -----------------------------------------------------------------------

  describe("registration", () => {
    it("registers handlers and removes them cleanly", () => {
      const getDb = vi.fn();
      registerSupportIpc(getDb);
      unregisterSupportIpc();
      expect(() => unregisterSupportIpc()).not.toThrow();
    });

    it("does not throw when unregistering without prior registration", () => {
      expect(() => unregisterSupportIpc()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Channel constants
  // -----------------------------------------------------------------------

  describe("channel constants", () => {
    it("exports outbox:list, outbox:retry, and outbox:export channel names", () => {
      expect(SUPPORT_CHANNELS.LIST_OUTBOX).toBe("outbox:list");
      expect(SUPPORT_CHANNELS.RETRY_OUTBOX).toBe("outbox:retry");
      expect(SUPPORT_CHANNELS.EXPORT_OUTBOX).toBe("outbox:export");
    });
  });

  // -----------------------------------------------------------------------
  // outbox:list handler
  // -----------------------------------------------------------------------

  describe("outbox:list handler", () => {
    it("returns all outbox entries ordered by created_at with their fields", async () => {
      const db = createTestDb();
      seedOutboxEntries(db);
      const getDb = vi.fn(() => db);

      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };
      const handler = mockIpc._handlers.get(SUPPORT_CHANNELS.LIST_OUTBOX);
      expect(handler).toBeDefined();

      const result = (await handler!()) as Array<Record<string, unknown>>;

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(5);

      // Verify shape of first entry
      const first = result[0]!;
      expect(first).toHaveProperty("id");
      expect(first).toHaveProperty("operation_type");
      expect(first).toHaveProperty("aggregate_type");
      expect(first).toHaveProperty("aggregate_id");
      expect(first).toHaveProperty("status");
      expect(first).toHaveProperty("last_error");
      expect(first).toHaveProperty("created_at");
      expect(first).toHaveProperty("payload");
      expect(first).toHaveProperty("attempt_count");

      // Entries ordered by created_at ASC (insert order)
      expect(first.id).toBe("ob-1");
    });

    it("filters by status when a status filter is provided", async () => {
      const db = createTestDb();
      seedOutboxEntries(db);
      const getDb = vi.fn(() => db);

      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };
      const handler = mockIpc._handlers.get(SUPPORT_CHANNELS.LIST_OUTBOX);
      expect(handler).toBeDefined();

      const result = (await handler!({}, { status: "failed" })) as Array<Record<string, unknown>>;

      expect(result.length).toBe(2);
      expect(result.every((e) => e.status === "failed")).toBe(true);
    });

    it("returns empty array when no entries match", async () => {
      const db = createTestDb();
      seedOutboxEntries(db);
      const getDb = vi.fn(() => db);

      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };
      const handler = mockIpc._handlers.get(SUPPORT_CHANNELS.LIST_OUTBOX);
      expect(handler).toBeDefined();

      const result = (await handler!({}, { status: "nonexistent" })) as Array<unknown>;
      expect(result).toEqual([]);
    });

    it("returns empty array when DB is unavailable", async () => {
      const getDb = vi.fn().mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };
      const handler = mockIpc._handlers.get(SUPPORT_CHANNELS.LIST_OUTBOX);
      expect(handler).toBeDefined();

      const result = await handler!();
      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // outbox:retry handler
  // -----------------------------------------------------------------------

  describe("outbox:retry handler", () => {
    it("resets a failed entry to pending and clears last_error", async () => {
      const db = createTestDb();
      seedOutboxEntries(db);
      const getDb = vi.fn(() => db);

      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };
      const handler = mockIpc._handlers.get(SUPPORT_CHANNELS.RETRY_OUTBOX);
      expect(handler).toBeDefined();

      const result = (await handler!({}, "ob-1")) as { success: boolean; error?: string };

      expect(result.success).toBe(true);

      // Verify the entry was reset
      const row = db.prepare("SELECT status, last_error FROM outbox WHERE id = ?").get("ob-1") as { status: string; last_error: string | null };
      expect(row.status).toBe("pending");
      expect(row.last_error).toBeNull();
    });

    it("returns error for unknown outbox id", async () => {
      const db = createTestDb();
      seedOutboxEntries(db);
      const getDb = vi.fn(() => db);

      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };
      const handler = mockIpc._handlers.get(SUPPORT_CHANNELS.RETRY_OUTBOX);
      expect(handler).toBeDefined();

      const result = (await handler!({}, "nonexistent")) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns degraded result when DB is unavailable", async () => {
      const getDb = vi.fn().mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };
      const handler = mockIpc._handlers.get(SUPPORT_CHANNELS.RETRY_OUTBOX);
      expect(handler).toBeDefined();

      const result = (await handler!({}, "ob-1")) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // outbox:export handler
  // -----------------------------------------------------------------------

  describe("outbox:export handler", () => {
    it("returns all outbox entries as JSON-serializable export data", async () => {
      const db = createTestDb();
      seedOutboxEntries(db);
      const getDb = vi.fn(() => db);

      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };
      const handler = mockIpc._handlers.get(SUPPORT_CHANNELS.EXPORT_OUTBOX);
      expect(handler).toBeDefined();

      const result = (await handler!()) as Array<Record<string, unknown>>;

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(5);

      // Verify all entries are present
      const ids = result.map((e) => e.id as string);
      expect(ids).toContain("ob-1");
      expect(ids).toContain("ob-2");
      expect(ids).toContain("ob-3");
      expect(ids).toContain("ob-4");
      expect(ids).toContain("ob-5");
    });

    it("returns empty array when DB is unavailable", async () => {
      const getDb = vi.fn().mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };
      const handler = mockIpc._handlers.get(SUPPORT_CHANNELS.EXPORT_OUTBOX);
      expect(handler).toBeDefined();

      const result = await handler!();
      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // outbox:retry handler — manual_fix confirmation gate
  // -----------------------------------------------------------------------

  describe("outbox:retry manual_fix gate", () => {
    it("rejects manual_fix entry without confirmation", async () => {
      const db = createTestDb();
      seedOutboxEntries(db);

      // Add a manual_fix entry
      db.prepare(`
        INSERT INTO outbox (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, last_error, created_at, updated_at)
        VALUES ('ob-mf', 'ik-mf', 'product_update', 'product', 'prod-99', '{}', 'manual_fix', 'Server rejected', '2026-01-01', '2026-01-01')
      `).run();

      const getDb = vi.fn(() => db);
      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };
      const handler = mockIpc._handlers.get(SUPPORT_CHANNELS.RETRY_OUTBOX);
      expect(handler).toBeDefined();

      const result = (await handler!({}, "ob-mf")) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain("manual_fix");
    });

    it("allows manual_fix entry WITH explicit confirmation", async () => {
      const db = createTestDb();
      seedOutboxEntries(db);

      db.prepare(`
        INSERT INTO outbox (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, last_error, created_at, updated_at)
        VALUES ('ob-mf2', 'ik-mf2', 'product_update', 'product', 'prod-99', '{}', 'manual_fix', 'Server rejected', '2026-01-01', '2026-01-01')
      `).run();

      const getDb = vi.fn(() => db);
      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };
      const handler = mockIpc._handlers.get(SUPPORT_CHANNELS.RETRY_OUTBOX);
      expect(handler).toBeDefined();

      const result = (await handler!({}, "ob-mf2", { confirmManualFix: true })) as { success: boolean; error?: string };
      expect(result.success).toBe(true);

      const row = db.prepare("SELECT status, last_error FROM outbox WHERE id = ?").get("ob-mf2") as { status: string; last_error: string | null };
      expect(row.status).toBe("pending");
      expect(row.last_error).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // outbox:retry-sale handler — sale + stock bundle
  // -----------------------------------------------------------------------

  describe("outbox:retry-sale handler", () => {
    it("resets a sale AND its linked stock adjustments to pending in one transaction", async () => {
      const db = createTestDb();

      const now = new Date().toISOString();

      // Sale entry
      db.prepare(`
        INSERT INTO outbox (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, last_error, created_at, updated_at)
        VALUES ('sale-ob-1', 'ik-sale-1', 'sale_create', 'sale', 'sale-1', '{"total":"100"}', 'failed', 'Conflict', ?, ?)
      `).run(now, now);

      // Seed a stock_movement linked to sale-1
      db.prepare(`
        INSERT INTO stock_movements (id, product_id, quantity, reason, sale_id, created_at)
        VALUES ('sm-1', 'prod-1', 3, 'sale', 'sale-1', ?)
      `).run(now);

      // Linked stock entry (aggregate_type='stock', aggregate_id matching a row in stock_movements)
      db.prepare(`
        INSERT INTO outbox (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, last_error, created_at, updated_at)
        VALUES ('stock-ob-1', 'ik-stock-1', 'stock_adjust', 'stock', 'stock-prod-1', '{"quantity":-3}', 'failed', 'Conflict', ?, ?)
      `).run(now, now);

      // Also link this entry via aggregate_id = sm-1 so the JOIN works
      db.prepare(`
        INSERT INTO outbox (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, last_error, created_at, updated_at)
        VALUES ('stock-ob-sm1', 'ik-stock-sm1', 'stock_adjust', 'stock', 'sm-1', '{"quantity":-3}', 'failed', 'Conflict', ?, ?)
      `).run(now, now);

      // Unrelated entry (should NOT be reset)
      db.prepare(`
        INSERT INTO outbox (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, last_error, created_at, updated_at)
        VALUES ('other-ob-1', 'ik-other-1', 'product_update', 'product', 'prod-1', '{}', 'failed', 'Network error', ?, ?)
      `).run(now, now);

      const getDb = vi.fn(() => db);
      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };

      const retrySaleHandler = mockIpc._handlers.get(SUPPORT_CHANNELS.RETRY_SALE);
      expect(retrySaleHandler).toBeDefined();

      const result = (await retrySaleHandler!({}, "sale-1")) as { success: boolean; error?: string; resetCount?: number };
      expect(result.success).toBe(true);

      // Sale entry reset
      const saleRow = db.prepare("SELECT status, last_error FROM outbox WHERE id = 'sale-ob-1'").get() as { status: string; last_error: string | null };
      expect(saleRow.status).toBe("pending");
      expect(saleRow.last_error).toBeNull();

      // Stock entry reset (via JOIN on stock_movements.sale_id)
      const stockRow = db.prepare("SELECT status, last_error FROM outbox WHERE id = 'stock-ob-sm1'").get() as { status: string; last_error: string | null };
      expect(stockRow.status).toBe("pending");
      expect(stockRow.last_error).toBeNull();

      // Unrelated entry NOT reset
      const otherRow = db.prepare("SELECT status FROM outbox WHERE id = 'other-ob-1'").get() as { status: string };
      expect(otherRow.status).toBe("failed");
    });

    it("returns error when no sale outbox entries found", async () => {
      const db = createTestDb();
      const getDb = vi.fn(() => db);
      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };

      const retrySaleHandler = mockIpc._handlers.get(SUPPORT_CHANNELS.RETRY_SALE);
      expect(retrySaleHandler).toBeDefined();

      const result = (await retrySaleHandler!({}, "nonexistent")) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain("No retryable");
    });
  });

  // -----------------------------------------------------------------------
  // outbox:resolve-conflict handler — conflict resolution
  // -----------------------------------------------------------------------

  describe("outbox:resolve-conflict handler", () => {
    it("resolves keep_local by resetting to pending with local metadata", async () => {
      const db = createTestDb();

      db.prepare(`
        INSERT INTO outbox (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, last_error, server_result, created_at, updated_at, local_device_timestamp)
        VALUES ('ob-conflict-1', 'ik-conflict-1', 'promotion_update', 'promotion', 'promo-1', '{"name":"Local Name"}', 'blocked_conflict', 'Version conflict', '{"server_version":"2026-01-01"}', '2026-01-01', '2026-01-01', '2026-07-15T00:00:00.000Z')
      `).run();

      const getDb = vi.fn(() => db);
      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };

      const resolveHandler = mockIpc._handlers.get(SUPPORT_CHANNELS.RESOLVE_CONFLICT);
      expect(resolveHandler).toBeDefined();

      const result = (await resolveHandler!({}, "ob-conflict-1", { resolution: "keep_local" })) as { success: boolean; error?: string };
      expect(result.success).toBe(true);

      const row = db.prepare("SELECT status, last_error FROM outbox WHERE id = 'ob-conflict-1'").get() as { status: string; last_error: string | null };
      expect(row.status).toBe("pending");
      expect(row.last_error).toBeNull();
    });

    it("resolves use_server by marking synced", async () => {
      const db = createTestDb();

      db.prepare(`
        INSERT INTO outbox (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, last_error, server_result, created_at, updated_at)
        VALUES ('ob-conflict-2', 'ik-conflict-2', 'provider_purchase_update', 'provider_purchase', 'pp-1', '{"provider_name":"Local"}', 'blocked_conflict', 'Version conflict', '{"server_payload":{"provider_name":"Server"}}', '2026-01-01', '2026-01-01')
      `).run();

      const getDb = vi.fn(() => db);
      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };

      const resolveHandler = mockIpc._handlers.get(SUPPORT_CHANNELS.RESOLVE_CONFLICT);
      expect(resolveHandler).toBeDefined();

      const result = (await resolveHandler!({}, "ob-conflict-2", { resolution: "use_server" })) as { success: boolean; error?: string };
      expect(result.success).toBe(true);

      const row = db.prepare("SELECT status FROM outbox WHERE id = 'ob-conflict-2'").get() as { status: string };
      expect(row.status).toBe("synced");
    });

    it("returns error for non-blocked_conflict entries", async () => {
      const db = createTestDb();
      seedOutboxEntries(db);

      const getDb = vi.fn(() => db);
      registerSupportIpc(getDb);

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };

      const resolveHandler = mockIpc._handlers.get(SUPPORT_CHANNELS.RESOLVE_CONFLICT);
      expect(resolveHandler).toBeDefined();

      const result = (await resolveHandler!({}, "ob-1", { resolution: "keep_local" })) as { success: boolean; error?: string };
      // ob-1 is "failed", not "blocked_conflict"
      expect(result.success).toBe(false);
      expect(result.error).toContain("blocked_conflict");
    });
  });
});
