// ---------------------------------------------------------------------------
// Infrastructure: SupportSqliteRepository integration tests
//
// Strict TDD RED phase: imports fail because SupportSqliteRepository and
// domain types do not exist yet. After GREEN implementation, these tests
// verify legacy SQL, status transitions, retry-sale transaction, conflict
// branches, and list/export ordering preserved by the Support migration.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { getDatabasePath, openDatabase, runMigrations, closeDatabase } from "../../db";

// ---- RED: these imports will fail until domain + repository are created ----
import { SupportSqliteRepository } from "./support-sqlite-repository";
import type {
  OutboxListItem,
  OutboxRetryResult,
  OutboxListFilter,
  ResolveConflictParams,
  RetryOutboxOptions,
} from "../../domain/support/support";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-support-hex-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createTestDb(dir: string): Database.Database {
  const dbPath = getDatabasePath(dir);
  const db = openDatabase(dbPath);
  runMigrations(db);
  return db;
}

function now(): string {
  return new Date().toISOString();
}

function insertOutbox(
  db: Database.Database,
  overrides: Partial<Record<string, unknown>> & { id: string; idempotency_key: string },
): void {
  const ts = (overrides.created_at as string) ?? now();
  const uts = (overrides.updated_at as string) ?? ts;
  db.prepare(`
    INSERT INTO outbox (
      id, idempotency_key, operation_type, aggregate_type, aggregate_id,
      payload, status, base_server_version, actor_user_id, attempt_count,
      next_retry_at, last_error, server_result, created_at, updated_at, synced_at,
      local_device_timestamp, manual_fix_reason, entity_label
    ) VALUES (
      @id, @idempotency_key, @operation_type, @aggregate_type, @aggregate_id,
      @payload, @status, @base_server_version, @actor_user_id, @attempt_count,
      @next_retry_at, @last_error, @server_result, @created_at, @updated_at, @synced_at,
      @local_device_timestamp, @manual_fix_reason, @entity_label
    )
  `).run({
    id: overrides.id,
    idempotency_key: overrides.idempotency_key,
    operation_type: (overrides.operation_type as string) ?? "test_op",
    aggregate_type: (overrides.aggregate_type as string) ?? "test",
    aggregate_id: (overrides.aggregate_id as string) ?? "test-1",
    payload: (overrides.payload as string) ?? "{}",
    status: (overrides.status as string) ?? "pending",
    base_server_version: (overrides.base_server_version as string) ?? null,
    actor_user_id: (overrides.actor_user_id as string) ?? null,
    attempt_count: (overrides.attempt_count as number) ?? 0,
    next_retry_at: (overrides.next_retry_at as string) ?? null,
    last_error: (overrides.last_error as string) ?? null,
    server_result: (overrides.server_result as string) ?? null,
    created_at: ts,
    updated_at: uts,
    synced_at: (overrides.synced_at as string) ?? null,
    local_device_timestamp: (overrides.local_device_timestamp as string) ?? null,
    manual_fix_reason: (overrides.manual_fix_reason as string) ?? null,
    entity_label: (overrides.entity_label as string) ?? null,
  });
}

// ---------------------------------------------------------------------------
// listOutbox
// ---------------------------------------------------------------------------

describe("SupportSqliteRepository.listOutbox", () => {
  let dir: string;
  let db: Database.Database;
  let repo: SupportSqliteRepository;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
    repo = new SupportSqliteRepository(() => db);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("returns all entries ordered by created_at ASC, rowid ASC when no filter", () => {
    insertOutbox(db, { id: "ob-c", idempotency_key: "ik-c", created_at: "2026-02-01T00:00:00Z", status: "failed" });
    insertOutbox(db, { id: "ob-a", idempotency_key: "ik-a", created_at: "2026-01-01T00:00:00Z", status: "pending" });
    insertOutbox(db, { id: "ob-b", idempotency_key: "ik-b", created_at: "2026-01-15T00:00:00Z", status: "synced" });

    const result = repo.listOutbox();

    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe("ob-a");
    expect(result[1]!.id).toBe("ob-b");
    expect(result[2]!.id).toBe("ob-c");
  });

  it("filters by status only", () => {
    insertOutbox(db, { id: "ob-1", idempotency_key: "ik-1", status: "failed" });
    insertOutbox(db, { id: "ob-2", idempotency_key: "ik-2", status: "pending" });
    insertOutbox(db, { id: "ob-3", idempotency_key: "ik-3", status: "failed" });

    const result = repo.listOutbox({ status: "failed" });

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.status === "failed")).toBe(true);
  });

  it("filters by aggregateType only", () => {
    insertOutbox(db, { id: "ob-1", idempotency_key: "ik-1", aggregate_type: "sale" });
    insertOutbox(db, { id: "ob-2", idempotency_key: "ik-2", aggregate_type: "product" });
    insertOutbox(db, { id: "ob-3", idempotency_key: "ik-3", aggregate_type: "sale" });

    const result = repo.listOutbox({ aggregateType: "sale" });

    expect(result).toHaveLength(2);
    expect(result.every((r) => r.aggregate_type === "sale")).toBe(true);
  });

  it("filters by both status and aggregateType", () => {
    insertOutbox(db, { id: "ob-1", idempotency_key: "ik-1", status: "failed", aggregate_type: "sale" });
    insertOutbox(db, { id: "ob-2", idempotency_key: "ik-2", status: "failed", aggregate_type: "product" });
    insertOutbox(db, { id: "ob-3", idempotency_key: "ik-3", status: "pending", aggregate_type: "sale" });

    const result = repo.listOutbox({ status: "failed", aggregateType: "sale" });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("ob-1");
  });

  it("returns empty array when no entries match", () => {
    insertOutbox(db, { id: "ob-1", idempotency_key: "ik-1", status: "pending" });

    const result = repo.listOutbox({ status: "nonexistent" });

    expect(result).toEqual([]);
  });

  it("returns empty array when outbox table is empty", () => {
    const result = repo.listOutbox();
    expect(result).toEqual([]);
  });

  it("returns all legacy fields on each row", () => {
    insertOutbox(db, {
      id: "ob-full", idempotency_key: "ik-full",
      operation_type: "sale_create", aggregate_type: "sale", aggregate_id: "sale-1",
      payload: '{"total":"100"}', status: "failed",
      base_server_version: "v1", actor_user_id: "user-1", attempt_count: 3,
      next_retry_at: "2026-03-01T00:00:00Z", last_error: "timeout",
      server_result: '{"ok":true}', created_at: "2026-02-01T00:00:00Z",
      updated_at: "2026-02-02T00:00:00Z", synced_at: null,
      local_device_timestamp: "2026-07-01T00:00:00Z",
      manual_fix_reason: "manual check", entity_label: "Test Entity",
    });

    const [row] = repo.listOutbox();
    expect(row!.id).toBe("ob-full");
    expect(row!.idempotency_key).toBe("ik-full");
    expect(row!.operation_type).toBe("sale_create");
    expect(row!.aggregate_type).toBe("sale");
    expect(row!.aggregate_id).toBe("sale-1");
    expect(row!.payload).toBe('{"total":"100"}');
    expect(row!.status).toBe("failed");
    expect(row!.base_server_version).toBe("v1");
    expect(row!.actor_user_id).toBe("user-1");
    expect(row!.attempt_count).toBe(3);
    expect(row!.next_retry_at).toBe("2026-03-01T00:00:00Z");
    expect(row!.last_error).toBe("timeout");
    expect(row!.server_result).toBe('{"ok":true}');
    expect(row!.created_at).toBe("2026-02-01T00:00:00Z");
    expect(row!.updated_at).toBe("2026-02-02T00:00:00Z");
    expect(row!.synced_at).toBeNull();
    expect(row!.local_device_timestamp).toBe("2026-07-01T00:00:00Z");
    expect(row!.manual_fix_reason).toBe("manual check");
    expect(row!.entity_label).toBe("Test Entity");
  });
});

// ---------------------------------------------------------------------------
// retryOutbox
// ---------------------------------------------------------------------------

describe("SupportSqliteRepository.retryOutbox", () => {
  let dir: string;
  let db: Database.Database;
  let repo: SupportSqliteRepository;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
    repo = new SupportSqliteRepository(() => db);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("resets a failed entry to pending and clears last_error and next_retry_at", () => {
    insertOutbox(db, {
      id: "ob-1", idempotency_key: "ik-1", status: "failed",
      last_error: "Conflict", next_retry_at: "2026-06-01T00:00:00Z",
    });

    const result = repo.retryOutbox("ob-1");

    expect(result.success).toBe(true);

    const row = db.prepare("SELECT status, last_error, next_retry_at, updated_at FROM outbox WHERE id = ?").get("ob-1") as Record<string, unknown>;
    expect(row.status).toBe("pending");
    expect(row.last_error).toBeNull();
    expect(row.next_retry_at).toBeNull();
    // updated_at should have been changed
    expect(row.updated_at).not.toBe("2026-02-01T00:00:00Z");
  });

  it("resets a retry_wait entry to pending", () => {
    insertOutbox(db, {
      id: "ob-2", idempotency_key: "ik-2", status: "retry_wait",
      last_error: "Network timeout", next_retry_at: "2026-07-01T00:00:00Z",
    });

    const result = repo.retryOutbox("ob-2");

    expect(result.success).toBe(true);

    const row = db.prepare("SELECT status, last_error, next_retry_at FROM outbox WHERE id = ?").get("ob-2") as Record<string, unknown>;
    expect(row.status).toBe("pending");
    expect(row.last_error).toBeNull();
    expect(row.next_retry_at).toBeNull();
  });

  it("rejects manual_fix entry without confirmation", () => {
    insertOutbox(db, { id: "ob-mf", idempotency_key: "ik-mf", status: "manual_fix", last_error: "Server rejected" });

    const result = repo.retryOutbox("ob-mf");

    expect(result.success).toBe(false);
    expect(result.error).toContain("manual_fix");

    // status should NOT have been changed
    const row = db.prepare("SELECT status FROM outbox WHERE id = ?").get("ob-mf") as Record<string, unknown>;
    expect(row.status).toBe("manual_fix");
  });

  it("allows manual_fix entry with confirmation", () => {
    insertOutbox(db, { id: "ob-mf2", idempotency_key: "ik-mf2", status: "manual_fix", last_error: "Server rejected" });

    const result = repo.retryOutbox("ob-mf2", { confirmManualFix: true });

    expect(result.success).toBe(true);

    const row = db.prepare("SELECT status, last_error FROM outbox WHERE id = ?").get("ob-mf2") as Record<string, unknown>;
    expect(row.status).toBe("pending");
    expect(row.last_error).toBeNull();
  });

  it("rejects pending entry (non-retryable)", () => {
    insertOutbox(db, { id: "ob-p", idempotency_key: "ik-p", status: "pending" });

    const result = repo.retryOutbox("ob-p");

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot retry entry with status "pending"');
  });

  it("rejects synced entry (non-retryable)", () => {
    insertOutbox(db, { id: "ob-s", idempotency_key: "ik-s", status: "synced" });

    const result = repo.retryOutbox("ob-s");

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot retry entry with status "synced"');
  });

  it("returns not-found for missing entry", () => {
    const result = repo.retryOutbox("nonexistent");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Outbox entry not found");
  });

  it("rejects blocked_conflict (non-retryable)", () => {
    insertOutbox(db, { id: "ob-bc", idempotency_key: "ik-bc", status: "blocked_conflict" });

    const result = repo.retryOutbox("ob-bc");

    expect(result.success).toBe(false);
    expect(result.error).toContain("blocked_conflict");
  });
});

// ---------------------------------------------------------------------------
// retrySale
// ---------------------------------------------------------------------------

describe("SupportSqliteRepository.retrySale", () => {
  let dir: string;
  let db: Database.Database;
  let repo: SupportSqliteRepository;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
    repo = new SupportSqliteRepository(() => db);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("resets a sale entry and linked stock entries to pending in one transaction", () => {
    const ts = now();

    // Sale outbox entry
    insertOutbox(db, {
      id: "sale-ob-1", idempotency_key: "ik-sale-1", aggregate_type: "sale",
      aggregate_id: "sale-1", status: "failed", last_error: "Conflict",
      created_at: ts, updated_at: ts,
    });

    // Seed a stock_movement linked to sale-1
    db.prepare(`
      INSERT INTO stock_movements (id, product_id, quantity, reason, sale_id, created_at)
      VALUES ('sm-1', 'prod-1', 3, 'sale', 'sale-1', ?)
    `).run(ts);

    // Stock outbox entry linked via stock_movements
    insertOutbox(db, {
      id: "stock-ob-1", idempotency_key: "ik-stock-1", aggregate_type: "stock",
      aggregate_id: "sm-1", status: "failed", last_error: "Conflict",
      created_at: ts, updated_at: ts,
    });

    // Another stock entry also linked
    db.prepare(`
      INSERT INTO stock_movements (id, product_id, quantity, reason, sale_id, created_at)
      VALUES ('sm-2', 'prod-2', 5, 'sale', 'sale-1', ?)
    `).run(ts);
    insertOutbox(db, {
      id: "stock-ob-2", idempotency_key: "ik-stock-2", aggregate_type: "stock",
      aggregate_id: "sm-2", status: "retry_wait", last_error: "Timeout",
      created_at: ts, updated_at: ts,
    });

    // Unrelated outbox entry (should NOT be reset)
    insertOutbox(db, {
      id: "other-ob", idempotency_key: "ik-other", aggregate_type: "product",
      aggregate_id: "prod-1", status: "failed", last_error: "Network error",
      created_at: ts, updated_at: ts,
    });

    const result = repo.retrySale("sale-1");

    expect(result.success).toBe(true);
    expect(result.resetCount).toBe(3);

    // Sale reset
    const saleRow = db.prepare("SELECT status, last_error FROM outbox WHERE id = 'sale-ob-1'").get() as Record<string, unknown>;
    expect(saleRow.status).toBe("pending");
    expect(saleRow.last_error).toBeNull();

    // Stock reset
    const stock1 = db.prepare("SELECT status FROM outbox WHERE id = 'stock-ob-1'").get() as Record<string, unknown>;
    expect(stock1.status).toBe("pending");
    const stock2 = db.prepare("SELECT status FROM outbox WHERE id = 'stock-ob-2'").get() as Record<string, unknown>;
    expect(stock2.status).toBe("pending");

    // Unrelated NOT reset
    const other = db.prepare("SELECT status FROM outbox WHERE id = 'other-ob'").get() as Record<string, unknown>;
    expect(other.status).toBe("failed");
  });

  it("resets only the sale when there are no linked stock entries", () => {
    const ts = now();
    insertOutbox(db, {
      id: "sale-ob-only", idempotency_key: "ik-sale-only", aggregate_type: "sale",
      aggregate_id: "sale-only", status: "failed", last_error: "Conflict",
      created_at: ts, updated_at: ts,
    });

    const result = repo.retrySale("sale-only");

    expect(result.success).toBe(true);
    expect(result.resetCount).toBe(1);

    const row = db.prepare("SELECT status FROM outbox WHERE id = 'sale-ob-only'").get() as Record<string, unknown>;
    expect(row.status).toBe("pending");
  });

  it("returns not-found error when no retryable sale exists", () => {
    const result = repo.retrySale("nonexistent");

    expect(result.success).toBe(false);
    expect(result.error).toBe("No retryable sale outbox entries found for this sale ID.");
  });

  it("returns not-found when sale exists but is not retryable (synced)", () => {
    insertOutbox(db, {
      id: "sale-synced", idempotency_key: "ik-synced", aggregate_type: "sale",
      aggregate_id: "sale-synced", status: "synced",
    });

    const result = repo.retrySale("sale-synced");

    expect(result.success).toBe(false);
    expect(result.error).toBe("No retryable sale outbox entries found for this sale ID.");
  });

  it("ignores non-retryable stock entries (only resets retryable ones)", () => {
    const ts = now();
    insertOutbox(db, {
      id: "sale-ob-mixed", idempotency_key: "ik-mixed", aggregate_type: "sale",
      aggregate_id: "sale-mixed", status: "failed",
      created_at: ts, updated_at: ts,
    });

    db.prepare(`
      INSERT INTO stock_movements (id, product_id, quantity, reason, sale_id, created_at)
      VALUES ('sm-synced', 'prod-s', 2, 'sale', 'sale-mixed', ?)
    `).run(ts);
    insertOutbox(db, {
      id: "stock-synced", idempotency_key: "ik-stock-synced", aggregate_type: "stock",
      aggregate_id: "sm-synced", status: "synced",
      created_at: ts, updated_at: ts,
    });

    const result = repo.retrySale("sale-mixed");

    expect(result.success).toBe(true);
    expect(result.resetCount).toBe(1); // only the sale, not the synced stock

    const stockRow = db.prepare("SELECT status FROM outbox WHERE id = 'stock-synced'").get() as Record<string, unknown>;
    expect(stockRow.status).toBe("synced"); // untouched
  });

  it("rolls back all changes on transaction failure (atomicity)", () => {
    const ts = now();
    insertOutbox(db, {
      id: "sale-atom", idempotency_key: "ik-atom", aggregate_type: "sale",
      aggregate_id: "sale-atom", status: "failed",
      created_at: ts, updated_at: ts,
    });

    db.prepare(`
      INSERT INTO stock_movements (id, product_id, quantity, reason, sale_id, created_at)
      VALUES ('sm-atom', 'prod-a', 1, 'sale', 'sale-atom', ?)
    `).run(ts);
    insertOutbox(db, {
      id: "stock-atom", idempotency_key: "ik-stock-atom", aggregate_type: "stock",
      aggregate_id: "sm-atom", status: "failed",
      created_at: ts, updated_at: ts,
    });

    // Create a trigger that forces failure on the second stock reset
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS force_stock_failure
      BEFORE UPDATE ON outbox
      WHEN OLD.id = 'stock-atom'
      BEGIN
        SELECT RAISE(ABORT, 'forced stock update failure');
      END;
    `);

    expect(() => repo.retrySale("sale-atom")).toThrow();

    // Both should still be in original state
    const saleRow = db.prepare("SELECT status FROM outbox WHERE id = 'sale-atom'").get() as Record<string, unknown>;
    expect(saleRow.status).toBe("failed");
    const stockRow = db.prepare("SELECT status FROM outbox WHERE id = 'stock-atom'").get() as Record<string, unknown>;
    expect(stockRow.status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// resolveConflict
// ---------------------------------------------------------------------------

describe("SupportSqliteRepository.resolveConflict", () => {
  let dir: string;
  let db: Database.Database;
  let repo: SupportSqliteRepository;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
    repo = new SupportSqliteRepository(() => db);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("keep_local resets to pending and clears last_error and next_retry_at", () => {
    insertOutbox(db, {
      id: "ob-bc", idempotency_key: "ik-bc", status: "blocked_conflict",
      last_error: "Version conflict", next_retry_at: "2026-06-01T00:00:00Z",
      server_result: '{"server":"payload"}',
    });

    const result = repo.resolveConflict("ob-bc", { resolution: "keep_local" });

    expect(result.success).toBe(true);

    const row = db.prepare("SELECT status, last_error, next_retry_at FROM outbox WHERE id = ?").get("ob-bc") as Record<string, unknown>;
    expect(row.status).toBe("pending");
    expect(row.last_error).toBeNull();
    expect(row.next_retry_at).toBeNull();
  });

  it("use_server marks as synced with synced_at and updated_at", () => {
    insertOutbox(db, {
      id: "ob-bc2", idempotency_key: "ik-bc2", status: "blocked_conflict",
      last_error: "Version conflict",
    });

    const result = repo.resolveConflict("ob-bc2", { resolution: "use_server" });

    expect(result.success).toBe(true);

    const row = db.prepare("SELECT status, synced_at, updated_at FROM outbox WHERE id = ?").get("ob-bc2") as Record<string, unknown>;
    expect(row.status).toBe("synced");
    expect(row.synced_at).toBeTruthy();
    expect(row.updated_at).toBeTruthy();
    // synced_at should be an ISO string
    expect(typeof row.synced_at).toBe("string");
    expect((row.synced_at as string).includes("T")).toBe(true);
  });

  it("rejects non-blocked_conflict entries", () => {
    insertOutbox(db, { id: "ob-failed", idempotency_key: "ik-failed", status: "failed" });

    const result = repo.resolveConflict("ob-failed", { resolution: "keep_local" });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Cannot resolve entry with status "failed"');
    expect(result.error).toContain('"blocked_conflict"');
  });

  it("returns not-found for missing entry", () => {
    const result = repo.resolveConflict("nonexistent", { resolution: "keep_local" });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Outbox entry not found");
  });

  it("rejects pending entries for conflict resolution", () => {
    insertOutbox(db, { id: "ob-pending", idempotency_key: "ik-pending", status: "pending" });

    const result = repo.resolveConflict("ob-pending", { resolution: "use_server" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("blocked_conflict");
  });
});

// ---------------------------------------------------------------------------
// exportOutbox
// ---------------------------------------------------------------------------

describe("SupportSqliteRepository.exportOutbox", () => {
  let dir: string;
  let db: Database.Database;
  let repo: SupportSqliteRepository;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
    repo = new SupportSqliteRepository(() => db);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("returns all entries ordered by created_at ASC, rowid ASC", () => {
    insertOutbox(db, { id: "ob-z", idempotency_key: "ik-z", created_at: "2026-03-01T00:00:00Z" });
    insertOutbox(db, { id: "ob-x", idempotency_key: "ik-x", created_at: "2026-01-01T00:00:00Z" });
    insertOutbox(db, { id: "ob-y", idempotency_key: "ik-y", created_at: "2026-02-01T00:00:00Z" });

    const result = repo.exportOutbox();

    expect(result).toHaveLength(3);
    expect(result[0]!.id).toBe("ob-x");
    expect(result[1]!.id).toBe("ob-y");
    expect(result[2]!.id).toBe("ob-z");
  });

  it("returns empty array for empty database", () => {
    const result = repo.exportOutbox();
    expect(result).toEqual([]);
  });

  it("returns same row shape as listOutbox with no filter", () => {
    insertOutbox(db, {
      id: "ob-e", idempotency_key: "ik-e",
      operation_type: "export_test", aggregate_type: "export", aggregate_id: "e-1",
      payload: '{"x":1}', status: "failed",
      base_server_version: "v2", actor_user_id: "u-1", attempt_count: 5,
      next_retry_at: null, last_error: "err", server_result: null,
      created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T00:00:00Z",
      synced_at: null,
    });

    const exportRows = repo.exportOutbox();
    const listRows = repo.listOutbox();

    expect(exportRows).toHaveLength(1);
    expect(listRows).toHaveLength(1);
    expect(exportRows[0]).toEqual(listRows[0]);
    expect(exportRows[0]!.id).toBe("ob-e");
  });
});
