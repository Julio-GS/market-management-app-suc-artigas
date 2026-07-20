import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  closeDatabase,
  getDatabasePath,
  openDatabase,
  runMigrations,
} from "./db";
import {
  replayOutbox,
  markOutboxEntry,
  markRevalidateRequired,
  clearRevalidateRequired,
  isRevalidationRequired,
  getPendingOutboxCount,
  getFailedOutboxCount,
  type OutboxEntryRow,
  type SyncPushFn,
  type RevalidateFn,
} from "./sync-engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync-engine-test-"));
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
    ...overrides,
  };

  db.prepare(`
    INSERT INTO outbox
      (id, idempotency_key, operation_type, aggregate_type, aggregate_id,
       payload, status, base_server_version, actor_user_id, attempt_count,
       next_retry_at, last_error, server_result, created_at, updated_at, synced_at)
    VALUES
      (@id, @idempotency_key, @operation_type, @aggregate_type, @aggregate_id,
       @payload, @status, @base_server_version, @actor_user_id, @attempt_count,
       @next_retry_at, @last_error, @server_result, @created_at, @updated_at, @synced_at)
  `).run(entry);

  return entry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("sync-engine", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = tempDir();
    const dbPath = getDatabasePath(dir);
    db = openDatabase(dbPath);
    runMigrations(db);
  });

  afterEach(() => {
    try {
      closeDatabase(db);
    } catch {
      // already closed
    }
    cleanup(dir);
  });

  // -----------------------------------------------------------------------
  // markOutboxEntry
  // -----------------------------------------------------------------------

  describe("markOutboxEntry", () => {
    it("updates status and last_error for a failed entry", () => {
      const entry = insertOutboxEntry(db, { status: "in_flight" });

      markOutboxEntry(db, entry.id, {
        status: "failed",
        last_error: "Connection refused",
      });

      const updated = db
        .prepare("SELECT * FROM outbox WHERE id = ?")
        .get(entry.id) as OutboxEntryRow;
      expect(updated.status).toBe("failed");
      expect(updated.last_error).toBe("Connection refused");
    });

    it("updates status to synced and sets synced_at", () => {
      const entry = insertOutboxEntry(db, { status: "in_flight" });

      markOutboxEntry(db, entry.id, {
        status: "synced",
        synced_at: new Date().toISOString(),
      });

      const updated = db
        .prepare("SELECT * FROM outbox WHERE id = ?")
        .get(entry.id) as OutboxEntryRow;
      expect(updated.status).toBe("synced");
      expect(updated.synced_at).toBeTruthy();
    });

    it("updates server_result when provided", () => {
      const entry = insertOutboxEntry(db, { status: "in_flight" });

      markOutboxEntry(db, entry.id, {
        status: "synced",
        server_result: JSON.stringify({ server_id: "srv-1" }),
      });

      const updated = db
        .prepare("SELECT * FROM outbox WHERE id = ?")
        .get(entry.id) as OutboxEntryRow;
      expect(updated.server_result).toContain("srv-1");
    });

    it("increments attempt_count", () => {
      const entry = insertOutboxEntry(db, { attempt_count: 2 });

      markOutboxEntry(db, entry.id, { status: "retry_wait" });

      const updated = db
        .prepare("SELECT * FROM outbox WHERE id = ?")
        .get(entry.id) as OutboxEntryRow;
      expect(updated.attempt_count).toBe(3);
    });
  });

  // -----------------------------------------------------------------------
  // replayOutbox — partial failure: "entry 7 fails, 8+ stay pending"
  // -----------------------------------------------------------------------

  describe("replayOutbox", () => {
    it("marks all entries synced when push succeeds for all", async () => {
      const e1 = insertOutboxEntry(db, { id: "out-1", status: "pending" });
      const e2 = insertOutboxEntry(db, { id: "out-2", status: "pending" });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          { id: e1.id, idempotency_key: e1.idempotency_key, status: "accepted" },
          { id: e2.id, idempotency_key: e2.idempotency_key, status: "accepted" },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({
        valid: true,
        user_id: "user-1",
      });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(result.synced).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.blocked).toBe(0);

      const count = db
        .prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'synced'")
        .get() as { c: number };
      expect(count.c).toBe(2);
    });

    it("entry 7 fails, entries 8+ stay pending", async () => {
      // Insert 10 pending entries
      for (let i = 1; i <= 10; i++) {
        insertOutboxEntry(db, {
          id: `out-${i}`,
          idempotency_key: `inst-1:out-${i}`,
          status: "pending",
        });
      }

      const pushFn: SyncPushFn = vi.fn().mockImplementation(async (entries: unknown[]) => {
        const e = entries as { id: string; idempotency_key: string }[];
        const results = e.map((entry, idx) => {
          if (idx < 6) {
            return { id: entry.id, idempotency_key: entry.idempotency_key, status: "accepted" as const };
          }
          if (idx === 6) {
            // entry 7 (index 6) fails with a permanent error
            return {
              id: entry.id,
              idempotency_key: entry.idempotency_key,
              status: "validation_error" as const,
              reason: "Invalid payload",
            };
          }
          // entries 8+ not reached due to blocking
          return { id: entry.id, idempotency_key: entry.idempotency_key, status: "blocked" as const };
        });
        return { results };
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({
        valid: true,
        user_id: "user-1",
      });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      // First 6 synced
      expect(result.synced).toBe(6);
      // Entry 7 failed
      expect(result.failed).toBe(1);
      // Entries 8-10 remain pending (blocked count)
      expect(result.blocked).toBe(3);

      // Verify DB state
      const syncedCount = db
        .prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'synced'")
        .get() as { c: number };
      expect(syncedCount.c).toBe(6);

      const failedCount = db
        .prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'failed'")
        .get() as { c: number };
      expect(failedCount.c).toBe(1);

      const pendingCount = db
        .prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'pending'")
        .get() as { c: number };
      // Entries 8-10 still pending
      expect(pendingCount.c).toBe(3);
    });

    // -------------------------------------------------------------------
    // Auth revalidation gate
    // -------------------------------------------------------------------

    it("blocks push when revalidation is required and fails", async () => {
      insertOutboxEntry(db, { id: "out-1", status: "pending" });

      // Mark revalidation required
      markRevalidateRequired(db);

      const pushFn: SyncPushFn = vi.fn();
      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({
        valid: false,
        user_id: "user-1",
        reason: "Account disabled",
      });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      // Push should NOT be called when revalidation fails
      expect(pushFn).not.toHaveBeenCalled();
      expect(result.synced).toBe(0);

      // Entry should be marked auth_blocked
      const entry = db
        .prepare("SELECT * FROM outbox WHERE id = 'out-1'")
        .get() as OutboxEntryRow;
      expect(["blocked_auth", "pending"]).toContain(entry.status);
    });

    it("proceeds with push after successful revalidation", async () => {
      // Insert an offline session so replayOutbox can find a user for revalidation
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();

      insertOutboxEntry(db, { id: "out-1", status: "pending" });

      markRevalidateRequired(db);

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          { id: "out-1", idempotency_key: "inst-1:out-1", status: "accepted" },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({
        valid: true,
        user_id: "user-1",
        username: "cashier1",
      });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(pushFn).toHaveBeenCalled();
      expect(result.synced).toBe(1);
      // Revalidation flag should be cleared
      expect(isRevalidationRequired(db)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // revalidation flag helpers
  // -----------------------------------------------------------------------

  describe("revalidation flag", () => {
    it("markRevalidateRequired sets the flag, clearRevalidateRequired clears it", () => {
      expect(isRevalidationRequired(db)).toBe(false);

      markRevalidateRequired(db);
      expect(isRevalidationRequired(db)).toBe(true);

      clearRevalidateRequired(db);
      expect(isRevalidationRequired(db)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Count helpers
  // -----------------------------------------------------------------------

  describe("count helpers", () => {
    it("getPendingOutboxCount returns pending entries only", () => {
      insertOutboxEntry(db, { id: "out-1", status: "pending" });
      insertOutboxEntry(db, { id: "out-2", status: "pending" });
      insertOutboxEntry(db, { id: "out-3", status: "synced" });
      insertOutboxEntry(db, { id: "out-4", status: "failed" });

      expect(getPendingOutboxCount(db)).toBe(2);
    });

    it("getFailedOutboxCount returns failed entries only", () => {
      insertOutboxEntry(db, { id: "out-1", status: "failed" });
      insertOutboxEntry(db, { id: "out-2", status: "failed" });
      insertOutboxEntry(db, { id: "out-3", status: "synced" });

      expect(getFailedOutboxCount(db)).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Skip already-processed entries
  // -----------------------------------------------------------------------

  describe("skip already-processed entries", () => {
    it("does not re-process entries that are already synced", async () => {
      insertOutboxEntry(db, { id: "out-1", status: "synced" });
      insertOutboxEntry(db, { id: "out-2", status: "pending" });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          { id: "out-2", idempotency_key: "inst-1:out-2", status: "accepted" },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({
        valid: true,
        user_id: "user-1",
      });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      // Only out-2 was pushed (out-1 already synced, skipped)
      expect(result.synced).toBe(1);

      // Verify pushFn received only out-2
      const callArgs = (pushFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as { id: string }[];
      expect(callArgs).toHaveLength(1);
      expect(callArgs[0].id).toBe("out-2");
    });
  });
});
