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
  recoverStaleInFlightEntries,
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
        local_device_timestamp: overrides.local_device_timestamp ?? null,
        manual_fix_reason: overrides.manual_fix_reason ?? null,
        entity_label: overrides.entity_label ?? null,
    ...overrides,
  };

  db.prepare(`
    INSERT INTO outbox
      (id, idempotency_key, operation_type, aggregate_type, aggregate_id,
       payload, status, base_server_version, actor_user_id, attempt_count,
       next_retry_at, last_error, server_result, created_at, updated_at, synced_at, local_device_timestamp, manual_fix_reason, entity_label)
    VALUES
      (@id, @idempotency_key, @operation_type, @aggregate_type, @aggregate_id,
       @payload, @status, @base_server_version, @actor_user_id, @attempt_count,
       @next_retry_at, @last_error, @server_result, @created_at, @updated_at, @synced_at, @local_device_timestamp, @manual_fix_reason, @entity_label)
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

      const manualFixCount = db
        .prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'manual_fix'")
        .get() as { c: number };
      expect(manualFixCount.c).toBe(1);

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
  // Stale in_flight recovery
  // -----------------------------------------------------------------------

  describe("recoverStaleInFlightEntries", () => {
    it("resets in_flight entries to pending on restart", () => {
      insertOutboxEntry(db, { id: "out-flight-1", status: "in_flight" });
      insertOutboxEntry(db, { id: "out-flight-2", status: "in_flight" });
      insertOutboxEntry(db, { id: "out-ok", status: "pending" });
      insertOutboxEntry(db, { id: "out-done", status: "synced" });

      const recovered = recoverStaleInFlightEntries(db);
      expect(recovered).toBe(2);

      // Verify only in_flight entries were reset
      const entries = db
        .prepare("SELECT id, status FROM outbox")
        .all() as { id: string; status: string }[];

      const f1 = entries.find((e) => e.id === "out-flight-1");
      const f2 = entries.find((e) => e.id === "out-flight-2");
      const ok = entries.find((e) => e.id === "out-ok");
      const done = entries.find((e) => e.id === "out-done");

      expect(f1!.status).toBe("pending");
      expect(f2!.status).toBe("pending");
      expect(ok!.status).toBe("pending"); // unchanged
      expect(done!.status).toBe("synced"); // unchanged
    });

    it("returns 0 when there are no in_flight entries", () => {
      insertOutboxEntry(db, { id: "out-1", status: "pending" });
      insertOutboxEntry(db, { id: "out-2", status: "synced" });

      const recovered = recoverStaleInFlightEntries(db);
      expect(recovered).toBe(0);
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

  // -----------------------------------------------------------------------
  // Promotion conflict resolution (LWW / apply / restore)
  // -----------------------------------------------------------------------

  describe("promotion conflict resolution", () => {
    it("local wins: re-queues promotion_update with LWW metadata", async () => {
      const localTs = "2026-07-20T12:00:00.000Z";
      const serverTs = "2026-07-20T10:00:00.000Z"; // older

      // Seed a promotion row locally so conflict payload exists
      db.prepare(`
        INSERT INTO promotions (id, name, type, scope, discount_percent, created_at, updated_at)
        VALUES ('promo-1', 'Summer Sale', 'percentage', 'product', 15, '2026-07-01', '2026-07-01')
      `).run();

      insertOutboxEntry(db, {
        id: "out-promo",
        idempotency_key: "inst-1:out-promo",
        operation_type: "promotion_update",
        aggregate_type: "promotion",
        aggregate_id: "promo-1",
        payload: JSON.stringify({ id: "promo-1", name: "Updated Sale", discount_percent: 25 }),
        status: "pending",
        local_device_timestamp: localTs,
      });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          {
            id: "out-promo",
            idempotency_key: "inst-1:out-promo",
            status: "conflict",
            reason: "Version conflict",
            server_version: serverTs,
          },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({
        valid: true,
        user_id: "user-1",
      });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      // Local wins → counted as failed for current cycle, re-queued pending
      expect(result.failed).toBe(1);
      expect(result.synced).toBe(0);

      const updated = db
        .prepare("SELECT * FROM outbox WHERE id = 'out-promo'")
        .get() as OutboxEntryRow;
      expect(updated.status).toBe("pending");

      const updatedPayload = JSON.parse(updated.payload);
      expect(updatedPayload.lww_resolution).toBe("local_wins");
    });

    it("server wins: applies server promotion payload locally and marks synced", async () => {
      const localTs = "2026-07-20T10:00:00.000Z";
      const serverTs = "2026-07-20T12:00:00.000Z"; // newer

      db.prepare(`
        INSERT INTO promotions (id, name, type, scope, discount_percent, created_at, updated_at)
        VALUES ('promo-2', 'Old Name', 'percentage', 'product', 10, '2026-07-01', '2026-07-01')
      `).run();

      insertOutboxEntry(db, {
        id: "out-promo-2",
        idempotency_key: "inst-1:out-promo-2",
        operation_type: "promotion_update",
        aggregate_type: "promotion",
        aggregate_id: "promo-2",
        payload: JSON.stringify({ id: "promo-2", name: "My Update", discount_percent: 30 }),
        status: "pending",
        local_device_timestamp: localTs,
      });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          {
            id: "out-promo-2",
            idempotency_key: "inst-1:out-promo-2",
            status: "conflict",
            reason: "Version conflict",
            server_version: serverTs,
            server_payload: { id: "promo-2", name: "Server Name", discount_percent: 20 },
          },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({
        valid: true,
        user_id: "user-1",
      });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(result.synced).toBe(1);

      // Outbox entry marked synced with LWW metadata
      const updated = db
        .prepare("SELECT * FROM outbox WHERE id = 'out-promo-2'")
        .get() as OutboxEntryRow;
      expect(updated.status).toBe("synced");

      const serverResult = JSON.parse(updated.server_result!);
      expect(serverResult.lww_resolution).toBe("server_wins");

      // Local product row updated with server data
      const promoRow = db
        .prepare("SELECT * FROM promotions WHERE id = 'promo-2'")
        .get() as { name: string; discount_percent: number };
      expect(promoRow.name).toBe("Server Name");
      expect(promoRow.discount_percent).toBe(20);
    });

    it("missing metadata: marks blocked_conflict", async () => {
      insertOutboxEntry(db, {
        id: "out-promo-3",
        idempotency_key: "inst-1:out-promo-3",
        operation_type: "promotion_update",
        aggregate_type: "promotion",
        aggregate_id: "promo-3",
        payload: JSON.stringify({ id: "promo-3" }),
        status: "pending",
        local_device_timestamp: null, // missing!
      });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          {
            id: "out-promo-3",
            idempotency_key: "inst-1:out-promo-3",
            status: "conflict",
            reason: "No timestamp",
            server_version: null, // also missing
          },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({
        valid: true,
        user_id: "user-1",
      });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(result.blocked).toBe(1);

      const updated = db
        .prepare("SELECT * FROM outbox WHERE id = 'out-promo-3'")
        .get() as OutboxEntryRow;
      expect(updated.status).toBe("blocked_conflict");
    });
  });

  // -----------------------------------------------------------------------
  // Promotion delete validation_error → restore from before snapshot
  // -----------------------------------------------------------------------

  describe("promotion delete restore", () => {
    it("restores promotion from before snapshot on definitive rejection", async () => {
      // Seed the promotion that will be "deleted"
      db.prepare(`
        INSERT INTO promotions (id, name, type, scope, discount_percent, created_at, updated_at)
        VALUES ('promo-del', 'To Delete', 'percentage', 'product', 10, '2026-07-01', '2026-07-01')
      `).run();

      const beforeSnapshot = {
        id: "promo-del",
        name: "To Delete",
        description: null,
        scope: "product",
        productId: null,
        type: "percentage",
        discountPercent: 10,
        startDate: null,
        endDate: null,
        weekdays: null,
        enabled: true,
        createdAt: "2026-07-01",
        updatedAt: "2026-07-01",
      };

      insertOutboxEntry(db, {
        id: "out-del-promo",
        idempotency_key: "inst-1:out-del-promo",
        operation_type: "promotion_delete",
        aggregate_type: "promotion",
        aggregate_id: "promo-del",
        payload: JSON.stringify({ id: "promo-del", before: beforeSnapshot }),
        status: "pending",
      });

      // Delete the local row first (simulating what deleteOfflinePromotion does)
      db.prepare("DELETE FROM promotions WHERE id = 'promo-del'").run();

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          {
            id: "out-del-promo",
            idempotency_key: "inst-1:out-del-promo",
            status: "validation_error",
            reason: "Server rejected delete — promotion already in use",
          },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({
        valid: true,
        user_id: "user-1",
      });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(result.failed).toBe(1);

      // Outbox entry marked manual_fix
      const updated = db
        .prepare("SELECT * FROM outbox WHERE id = 'out-del-promo'")
        .get() as OutboxEntryRow;
      expect(updated.status).toBe("manual_fix");

      // Product restored from before snapshot
      const restored = db
        .prepare("SELECT * FROM promotions WHERE id = 'promo-del'")
        .get() as { name: string } | undefined;
      expect(restored).toBeDefined();
      expect(restored!.name).toBe("To Delete");
    });
  });

  // -----------------------------------------------------------------------
  // Provider purchase conflict resolution
  // -----------------------------------------------------------------------

  describe("provider purchase conflict resolution", () => {
    it("local wins: re-queues with LWW metadata", async () => {
      const localTs = "2026-07-20T15:00:00.000Z";
      const serverTs = "2026-07-20T10:00:00.000Z";

      db.prepare(`
        INSERT INTO provider_purchases (id, provider_name, amount, created_at, updated_at)
        VALUES ('pp-1', 'ACME', '1000.00', '2026-07-01', '2026-07-01')
      `).run();

      insertOutboxEntry(db, {
        id: "out-pp",
        idempotency_key: "inst-1:out-pp",
        operation_type: "provider_purchase_update",
        aggregate_type: "provider_purchase",
        aggregate_id: "pp-1",
        payload: JSON.stringify({ id: "pp-1", provider_name: "Updated", amount: "2000.00" }),
        status: "pending",
        local_device_timestamp: localTs,
      });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          {
            id: "out-pp",
            idempotency_key: "inst-1:out-pp",
            status: "conflict",
            reason: "Version conflict",
            server_version: serverTs,
          },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({
        valid: true,
        user_id: "user-1",
      });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(result.failed).toBe(1);

      const updated = db
        .prepare("SELECT * FROM outbox WHERE id = 'out-pp'")
        .get() as OutboxEntryRow;
      expect(updated.status).toBe("pending");
      expect(JSON.parse(updated.payload).lww_resolution).toBe("local_wins");
    });

    it("server wins: applies server payload locally and marks synced", async () => {
      const localTs = "2026-07-20T10:00:00.000Z";
      const serverTs = "2026-07-20T15:00:00.000Z";

      db.prepare(`
        INSERT INTO provider_purchases (id, provider_name, amount, created_at, updated_at)
        VALUES ('pp-2', 'Old Name', '500.00', '2026-07-01', '2026-07-01')
      `).run();

      insertOutboxEntry(db, {
        id: "out-pp-2",
        idempotency_key: "inst-1:out-pp-2",
        operation_type: "provider_purchase_update",
        aggregate_type: "provider_purchase",
        aggregate_id: "pp-2",
        payload: JSON.stringify({ id: "pp-2", provider_name: "My Update" }),
        status: "pending",
        local_device_timestamp: localTs,
      });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          {
            id: "out-pp-2",
            idempotency_key: "inst-1:out-pp-2",
            status: "conflict",
            reason: "Version conflict",
            server_version: serverTs,
            server_payload: { id: "pp-2", provider_name: "Server Name", amount: "1500.00", payment_method: "card" },
          },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({
        valid: true,
        user_id: "user-1",
      });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(result.synced).toBe(1);

      const updated = db
        .prepare("SELECT * FROM outbox WHERE id = 'out-pp-2'")
        .get() as OutboxEntryRow;
      expect(updated.status).toBe("synced");
      expect(JSON.parse(updated.server_result!).lww_resolution).toBe("server_wins");

      const ppRow = db
        .prepare("SELECT * FROM provider_purchases WHERE id = 'pp-2'")
        .get() as { provider_name: string; amount: string; payment_method: string | null };
      expect(ppRow.provider_name).toBe("Server Name");
      expect(ppRow.amount).toBe("1500.00");
      expect(ppRow.payment_method).toBe("card");
    });

    it("missing metadata: marks blocked_conflict", async () => {
      insertOutboxEntry(db, {
        id: "out-pp-3",
        idempotency_key: "inst-1:out-pp-3",
        operation_type: "provider_purchase_update",
        aggregate_type: "provider_purchase",
        aggregate_id: "pp-3",
        payload: JSON.stringify({ id: "pp-3" }),
        status: "pending",
        local_device_timestamp: null,
      });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          {
            id: "out-pp-3",
            idempotency_key: "inst-1:out-pp-3",
            status: "conflict",
            reason: "Missing metadata",
            server_version: null,
          },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({
        valid: true,
        user_id: "user-1",
      });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(result.blocked).toBe(1);

      const updated = db
        .prepare("SELECT * FROM outbox WHERE id = 'out-pp-3'")
        .get() as OutboxEntryRow;
      expect(updated.status).toBe("blocked_conflict");
    });
  });

  // -----------------------------------------------------------------------
  // Provider purchase delete restore
  // -----------------------------------------------------------------------

  describe("provider purchase delete restore", () => {
    it("restores purchase from before snapshot on definitive rejection", async () => {
      db.prepare(`
        INSERT INTO provider_purchases (id, provider_name, amount, payment_method, created_at, updated_at)
        VALUES ('pp-del', 'DeleteMe', '5000.00', 'transfer', '2026-07-01', '2026-07-01')
      `).run();

      const beforeSnapshot = {
        id: "pp-del",
        providerName: "DeleteMe",
        amount: "5000.00",
        paymentMethod: "transfer",
        createdAt: "2026-07-01",
        updatedAt: "2026-07-01",
      };

      insertOutboxEntry(db, {
        id: "out-del-pp",
        idempotency_key: "inst-1:out-del-pp",
        operation_type: "provider_purchase_delete",
        aggregate_type: "provider_purchase",
        aggregate_id: "pp-del",
        payload: JSON.stringify({ id: "pp-del", before: beforeSnapshot }),
        status: "pending",
      });

      db.prepare("DELETE FROM provider_purchases WHERE id = 'pp-del'").run();

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          {
            id: "out-del-pp",
            idempotency_key: "inst-1:out-del-pp",
            status: "validation_error",
            reason: "Server rejected delete",
          },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({
        valid: true,
        user_id: "user-1",
      });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(result.failed).toBe(1);

      const updated = db
        .prepare("SELECT * FROM outbox WHERE id = 'out-del-pp'")
        .get() as OutboxEntryRow;
      expect(updated.status).toBe("manual_fix");

      const restored = db
        .prepare("SELECT * FROM provider_purchases WHERE id = 'pp-del'")
        .get() as { provider_name: string; amount: string } | undefined;
      expect(restored).toBeDefined();
      expect(restored!.provider_name).toBe("DeleteMe");
      expect(restored!.amount).toBe("5000.00");
    });
  });
});
