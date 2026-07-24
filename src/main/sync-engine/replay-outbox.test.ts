import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayOutbox } from "./replay-outbox";
import type { OutboxEntryRow, SyncPushFn, RevalidateFn } from "./types";

// ---------------------------------------------------------------------------
// Slice 4 RED — this test must FAIL because replay-outbox.ts does not exist.
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "replay-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function insertOutboxEntry(
  db: Database.Database,
  overrides: Partial<OutboxEntryRow> = {},
): OutboxEntryRow {
  const id = overrides.id ?? `out-${Math.random().toString(36).slice(2, 8)}`;
  const entry: OutboxEntryRow = {
    id,
    idempotency_key: overrides.idempotency_key ?? `inst-1:${id}`,
    operation_type: "sale_create",
    aggregate_type: "sale",
    aggregate_id: "sale-1",
    payload: JSON.stringify({ saleId: "sale-1", total: "100" }),
    status: "pending",
    base_server_version: null,
    actor_user_id: null,
    attempt_count: 0,
    next_retry_at: null,
    last_error: null,
    server_result: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    synced_at: null,
    local_device_timestamp: overrides.local_device_timestamp ?? null,
    manual_fix_reason: overrides.manual_fix_reason ?? null,
    entity_label: overrides.entity_label ?? null,
    ...overrides,
  };

  db.prepare(`
    INSERT INTO outbox
      (id, idempotency_key, operation_type, aggregate_type, aggregate_id,
       payload, status, base_server_version, actor_user_id, attempt_count,
       next_retry_at, last_error, server_result, created_at, updated_at, synced_at,
       local_device_timestamp, manual_fix_reason, entity_label)
    VALUES
      (@id, @idempotency_key, @operation_type, @aggregate_type, @aggregate_id,
       @payload, @status, @base_server_version, @actor_user_id, @attempt_count,
       @next_retry_at, @last_error, @server_result, @created_at, @updated_at, @synced_at,
       @local_device_timestamp, @manual_fix_reason, @entity_label)
  `).run(entry);

  return entry;
}

describe("replay-outbox", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = tempDir();
    const dbPath = path.join(dir, "test.db");
    db = new Database(dbPath);
    // Minimal schema needed for replay
    db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS offline_sessions (
        user_id TEXT PRIMARY KEY, username TEXT, last_validated_at TEXT,
        created_at TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, idempotency_key TEXT, operation_type TEXT,
        aggregate_type TEXT, aggregate_id TEXT, payload TEXT, status TEXT,
        base_server_version TEXT, actor_user_id TEXT, attempt_count INTEGER DEFAULT 0,
        next_retry_at TEXT, last_error TEXT, server_result TEXT,
        created_at TEXT, updated_at TEXT, synced_at TEXT,
        local_device_timestamp TEXT, manual_fix_reason TEXT, entity_label TEXT
      );
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY, detalle TEXT DEFAULT '', costo_neto TEXT,
        costo_final TEXT, iva TEXT, cambio_costo TEXT DEFAULT 'fixed',
        cambio_precio TEXT DEFAULT 'fixed', etiqueta TEXT DEFAULT '',
        facturable INTEGER DEFAULT 1, maneja_stock INTEGER DEFAULT 1,
        codigos TEXT DEFAULT '[]', pricing_mode TEXT DEFAULT 'fixed',
        is_protected INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS promotions (
        id TEXT PRIMARY KEY, name TEXT, description TEXT, scope TEXT,
        product_id TEXT, type TEXT, discount_percent REAL,
        start_date TEXT, end_date TEXT, weekdays TEXT, enabled INTEGER DEFAULT 1,
        created_at TEXT, updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS provider_purchases (
        id TEXT PRIMARY KEY, provider_name TEXT, amount TEXT,
        payment_method TEXT, created_at TEXT, updated_at TEXT
      );
    `);
  });

  afterEach(() => {
    try { db.close(); } catch { /* already closed */ }
    cleanup(dir);
  });

  it("handles pushFn throwing an error (marks retry_wait, blocks later entries)", async () => {
    insertOutboxEntry(db, { id: "out-1", status: "pending" });
    insertOutboxEntry(db, { id: "out-2", status: "pending" });

    const pushFn: SyncPushFn = vi.fn().mockRejectedValue(new Error("Network down"));
    const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "u1" });

    const result = await replayOutbox(db, pushFn, revalidateFn);

    expect(result.failed).toBe(1);
    expect(result.blocked).toBe(1);

    const e1 = db.prepare("SELECT status, last_error FROM outbox WHERE id = 'out-1'").get() as { status: string; last_error: string };
    expect(e1.status).toBe("retry_wait");
    expect(e1.last_error).toBe("Network down");
  });

  it("handles no result returned from server", async () => {
    insertOutboxEntry(db, { id: "out-nr", status: "pending" });

    const pushFn: SyncPushFn = vi.fn().mockResolvedValue({ results: [] });
    const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "u1" });

    const result = await replayOutbox(db, pushFn, revalidateFn);

    expect(result.failed).toBe(1);

    const entry = db.prepare("SELECT status, last_error FROM outbox WHERE id = 'out-nr'").get() as { status: string; last_error: string };
    expect(entry.status).toBe("failed");
    expect(entry.last_error).toBe("No result returned from server for this entry.");
  });
});
