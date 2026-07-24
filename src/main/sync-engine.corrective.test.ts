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
  getOutboxStatusCounts,
  type OutboxEntryRow,
  type OutboxStatusCounts,
  type SyncPushFn,
  type RevalidateFn,
} from "./sync-engine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sync-engine-corrective-test-"));
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
  } as OutboxEntryRow;

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

// Extended row type with new columns for assertions
type OutboxRowExt = OutboxEntryRow & {
  local_device_timestamp: string | null;
  manual_fix_reason: string | null;
  entity_label: string | null;
};

// ---------------------------------------------------------------------------
// CORRECTIVE TESTS — verify-report remediation
// ---------------------------------------------------------------------------

describe("sync-engine-corrective", () => {
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

  // -------------------------------------------------------------------
  // GAP 1: manual_fix transition for definitive rejection
  // -------------------------------------------------------------------

  describe("manual_fix transition for definitive rejection", () => {
    it("transitions validation_error to manual_fix with reason persisted in manual_fix_reason column", async () => {
      insertOutboxEntry(db, { id: "out-mf-1", operation_type: "sale_create", aggregate_type: "sale", status: "pending" });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          { id: "out-mf-1", idempotency_key: "inst-1:out-mf-1", status: "validation_error", reason: "Invalid sale total" },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "user-1" });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(result.failed).toBe(1);
      const entry = db.prepare("SELECT * FROM outbox WHERE id = 'out-mf-1'").get() as OutboxRowExt;
      expect(entry.status).toBe("manual_fix");
      expect(entry.last_error).toBe("Invalid sale total");
      expect(entry.server_result).toBeTruthy();
      // GAP 6: dedicated manual_fix_reason column must be populated
      expect(entry.manual_fix_reason).toBe("Invalid sale total");
    });

    it("does not transition to failed for validation_error", async () => {
      insertOutboxEntry(db, { id: "out-mf-2", operation_type: "product_update", aggregate_type: "product", status: "pending" });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          { id: "out-mf-2", idempotency_key: "inst-1:out-mf-2", status: "validation_error", reason: "Product no longer exists on server" },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "user-1" });

      await replayOutbox(db, pushFn, revalidateFn);

      const entry = db.prepare("SELECT * FROM outbox WHERE id = 'out-mf-2'").get() as OutboxRowExt;
      expect(entry.status).toBe("manual_fix");
      expect(entry.manual_fix_reason).toBe("Product no longer exists on server");
    });

    it("blocks subsequent entries after a definitive rejection", async () => {
      insertOutboxEntry(db, { id: "out-mf-3", status: "pending" });
      insertOutboxEntry(db, { id: "out-mf-4", status: "pending" });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          { id: "out-mf-3", idempotency_key: "inst-1:out-mf-3", status: "validation_error", reason: "Rejected" },
          { id: "out-mf-4", idempotency_key: "inst-1:out-mf-4", status: "accepted" },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "user-1" });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(result.failed).toBe(1);
      expect(result.blocked).toBe(1);

      const e1 = db.prepare("SELECT status FROM outbox WHERE id = 'out-mf-3'").get() as { status: string };
      const e2 = db.prepare("SELECT status FROM outbox WHERE id = 'out-mf-4'").get() as { status: string };
      expect(e1.status).toBe("manual_fix");
      expect(e2.status).toBe("pending");
    });

    // GAP 4: product_delete definitive rejection → restore product from before snapshot
    it("restores product from before snapshot when product_delete is definitively rejected", async () => {
      const beforeSnapshot = {
        id: "prod-del-1",
        detalle: "Product To Delete",
        costoNeto: null,
        costoFinal: null,
        iva: null,
        cambioCosto: "fixed",
        cambioPrecio: "fixed",
        etiqueta: "",
        facturable: true,
        manejaStock: true,
        codigos: [],
        pricingMode: "fixed",
        createdAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-01T00:00:00.000Z",
      };

      insertOutboxEntry(db, {
        id: "out-del-1",
        operation_type: "product_delete",
        aggregate_type: "product",
        aggregate_id: "prod-del-1",
        status: "pending",
        payload: JSON.stringify({ id: "prod-del-1", before: beforeSnapshot }),
      });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          { id: "out-del-1", idempotency_key: "inst-1:out-del-1", status: "validation_error", reason: "Cannot delete synced product" },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "user-1" });

      await replayOutbox(db, pushFn, revalidateFn);

      // The entry must be manual_fix
      const entry = db.prepare("SELECT * FROM outbox WHERE id = 'out-del-1'").get() as OutboxRowExt;
      expect(entry.status).toBe("manual_fix");
      expect(entry.manual_fix_reason).toBe("Cannot delete synced product");

      // The product must be restored from the before snapshot
      const product = db.prepare("SELECT * FROM products WHERE id = 'prod-del-1'").get() as { detalle: string; etiqueta: string; is_protected: number } | undefined;
      expect(product).toBeTruthy();
      expect(product!.detalle).toBe("Product To Delete");
      expect(product!.is_protected).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // GAP 2: product LWW conflict + blocked_conflict (CORRECTED)
  // -------------------------------------------------------------------

  describe("product LWW conflict resolution", () => {
    it("local wins: uses local_device_timestamp column and re-queues as pending for re-push", async () => {
      const localTs = "2026-07-15T12:00:00.000Z";
      const serverTs = "2026-07-14T12:00:00.000Z";

      db.prepare(`
        INSERT INTO products (id, detalle, costo_neto, costo_final, iva, cambio_costo, cambio_precio,
          etiqueta, facturable, maneja_stock, codigos, pricing_mode, is_protected, created_at, updated_at)
        VALUES ('prod-1', 'Test Product', NULL, NULL, NULL, 'fixed', 'fixed', '', 1, 1, '[]', 'fixed', 0,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();

      insertOutboxEntry(db, {
        id: "out-lww-1",
        operation_type: "product_update",
        aggregate_type: "product",
        aggregate_id: "prod-1",
        status: "pending",
        created_at: "2026-07-01T00:00:00.000Z",
        local_device_timestamp: localTs,
      });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          {
            id: "out-lww-1",
            idempotency_key: "inst-1:out-lww-1",
            status: "conflict",
            reason: "Version mismatch",
            server_version: serverTs,
          },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "user-1" });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      // Local wins → NOT synced; entry goes back to pending for re-push with LWW metadata
      expect(result.synced).toBe(0);
      expect(result.failed).toBe(1);
      const entry = db.prepare("SELECT * FROM outbox WHERE id = 'out-lww-1'").get() as OutboxRowExt;
      expect(entry.status).toBe("pending");
      // Verify the payload now includes LWW resolution metadata
      const payload = JSON.parse(entry.payload);
      expect(payload.lww_resolution).toBe("local_wins");
      expect(payload.local_device_timestamp).toBe(localTs);
    });

    it("server wins: applies server product payload locally and marks synced", async () => {
      const localTs = "2026-07-14T10:00:00.000Z";
      const serverTs = "2026-07-15T10:00:00.000Z";

      db.prepare(`
        INSERT INTO products (id, detalle, costo_neto, costo_final, iva, cambio_costo, cambio_precio,
          etiqueta, facturable, maneja_stock, codigos, pricing_mode, is_protected, created_at, updated_at)
        VALUES ('prod-2', 'Old Name', NULL, NULL, NULL, 'fixed', 'fixed', '', 1, 1, '[]', 'fixed', 0,
          '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();

      insertOutboxEntry(db, {
        id: "out-lww-2",
        operation_type: "product_update",
        aggregate_type: "product",
        aggregate_id: "prod-2",
        status: "pending",
        created_at: "2026-07-01T00:00:00.000Z",
        local_device_timestamp: localTs,
      });

      const serverProductPayload = { id: "prod-2", detalle: "Server Won Name", costo_neto: "500", updated_at: serverTs };

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          {
            id: "out-lww-2",
            idempotency_key: "inst-1:out-lww-2",
            status: "conflict",
            reason: "Version mismatch",
            server_version: serverTs,
            server_payload: serverProductPayload,
          },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "user-1" });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(result.synced).toBe(1);
      const entry = db.prepare("SELECT * FROM outbox WHERE id = 'out-lww-2'").get() as OutboxRowExt;
      expect(entry.status).toBe("synced");
      // Server-won product payload must be applied locally
      const product = db.prepare("SELECT * FROM products WHERE id = 'prod-2'").get() as { detalle: string; costo_neto: string | null; updated_at: string };
      expect(product.detalle).toBe("Server Won Name");
      expect(product.costo_neto).toBe("500");
    });

    it("transitions to blocked_conflict when server_version metadata is missing", async () => {
      insertOutboxEntry(db, {
        id: "out-bc-1",
        operation_type: "product_update",
        aggregate_type: "product",
        aggregate_id: "prod-1",
        status: "pending",
        local_device_timestamp: "2026-07-15T12:00:00.000Z",
      });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          {
            id: "out-bc-1",
            idempotency_key: "inst-1:out-bc-1",
            status: "conflict",
            reason: "Conflict detected",
          },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "user-1" });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(result.blocked).toBe(1);
      const entry = db.prepare("SELECT * FROM outbox WHERE id = 'out-bc-1'").get() as OutboxRowExt;
      expect(entry.status).toBe("blocked_conflict");
    });

    it("non-product conflict transitions to blocked_conflict", async () => {
      insertOutboxEntry(db, {
        id: "out-bc-2",
        operation_type: "sale_create",
        aggregate_type: "sale",
        aggregate_id: "sale-1",
        status: "pending",
      });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          {
            id: "out-bc-2",
            idempotency_key: "inst-1:out-bc-2",
            status: "conflict",
            reason: "Unexpected server conflict on sale",
          },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "user-1" });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(result.blocked).toBe(1);
      const entry = db.prepare("SELECT * FROM outbox WHERE id = 'out-bc-2'").get() as OutboxEntryRow;
      expect(entry.status).toBe("blocked_conflict");
    });
  });

  // -------------------------------------------------------------------
  // GAP 3: deterministic session + unblock after revalidation
  // -------------------------------------------------------------------

  describe("auth revalidation unblock flow", () => {
    it("uses the most recently validated session for revalidation", async () => {
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-old', 'old', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-recent', 'recent', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
      `).run();

      insertOutboxEntry(db, { id: "out-ua-1", status: "pending" });
      markRevalidateRequired(db);

      let revalidatedUserId = "";
      const revalidateFn: RevalidateFn = vi.fn().mockImplementation(async (userId: string) => {
        revalidatedUserId = userId;
        return { valid: true, user_id: userId, username: "recent" };
      });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [{ id: "out-ua-1", idempotency_key: "inst-1:out-ua-1", status: "accepted" }],
      });

      await replayOutbox(db, pushFn, revalidateFn);

      expect(revalidatedUserId).toBe("user-recent");
    });

    it("unblocks blocked_auth entries for the revalidated actor", async () => {
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('actor-1', 'cashier', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
      `).run();

      db.prepare(`
        INSERT INTO outbox
          (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, actor_user_id, created_at, updated_at)
        VALUES ('blocked-1', 'ik:b1', 'product_create', 'product', 'p-1', '{}', 'blocked_auth', 'actor-1', '2026-07-01', '2026-07-01')
      `).run();

      insertOutboxEntry(db, { id: "out-ua-2", status: "pending", actor_user_id: "actor-1" });

      markRevalidateRequired(db);

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "actor-1", username: "cashier" });
      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [{ id: "out-ua-2", idempotency_key: "inst-1:out-ua-2", status: "accepted" }],
      });

      await replayOutbox(db, pushFn, revalidateFn);

      const blocked = db.prepare("SELECT status FROM outbox WHERE id = 'blocked-1'").get() as { status: string };
      // After unblock, the entry becomes pending, gets pushed in same cycle.
      expect(blocked.status).toBe("synced");
      expect(isRevalidationRequired(db)).toBe(false);
    });

    it("does not unblock another actors blocked_auth entries", async () => {
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('actor-1', 'cashier', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
      `).run();

      db.prepare(`
        INSERT INTO outbox
          (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, actor_user_id, created_at, updated_at)
        VALUES ('blocked-other', 'ik:bo', 'sale_create', 'sale', 's-1', '{}', 'blocked_auth', 'actor-other', '2026-07-01', '2026-07-01')
      `).run();

      insertOutboxEntry(db, { id: "out-ua-3", status: "pending" });
      markRevalidateRequired(db);

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "actor-1" });
      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [{ id: "out-ua-3", idempotency_key: "inst-1:out-ua-3", status: "accepted" }],
      });

      await replayOutbox(db, pushFn, revalidateFn);

      const other = db.prepare("SELECT status FROM outbox WHERE id = 'blocked-other'").get() as { status: string };
      expect(other.status).toBe("blocked_auth");
    });
  });

  // -------------------------------------------------------------------
  // GAP 4: getOutboxStatusCounts for all required statuses
  // -------------------------------------------------------------------

  describe("getOutboxStatusCounts", () => {
    it("returns counts for all 8 required statuses", () => {
      insertOutboxEntry(db, { id: "c-1", status: "pending" });
      insertOutboxEntry(db, { id: "c-2", status: "pending" });
      insertOutboxEntry(db, { id: "c-3", status: "in_flight" });
      insertOutboxEntry(db, { id: "c-4", status: "retry_wait" });
      insertOutboxEntry(db, { id: "c-5", status: "blocked_auth" });
      insertOutboxEntry(db, { id: "c-6", status: "blocked_conflict" });
      insertOutboxEntry(db, { id: "c-7", status: "manual_fix" });
      insertOutboxEntry(db, { id: "c-8", status: "failed" });
      insertOutboxEntry(db, { id: "c-9", status: "synced" });

      const counts = getOutboxStatusCounts(db);

      expect(counts.pending).toBe(2);
      expect(counts.in_flight).toBe(1);
      expect(counts.retry_wait).toBe(1);
      expect(counts.blocked_auth).toBe(1);
      expect(counts.blocked_conflict).toBe(1);
      expect(counts.manual_fix).toBe(1);
      expect(counts.failed).toBe(1);
      expect(counts.synced).toBe(1);
    });

    it("returns zero for all statuses when outbox is empty", () => {
      const counts = getOutboxStatusCounts(db);

      expect(counts.pending).toBe(0);
      expect(counts.in_flight).toBe(0);
      expect(counts.retry_wait).toBe(0);
      expect(counts.blocked_auth).toBe(0);
      expect(counts.blocked_conflict).toBe(0);
      expect(counts.manual_fix).toBe(0);
      expect(counts.failed).toBe(0);
      expect(counts.synced).toBe(0);
    });
  });

  // -------------------------------------------------------------------
  // GAP 5: auth_blocked/blocked → blocked_auth
  // -------------------------------------------------------------------

  describe("auth_blocked server result handling", () => {
    it("transitions auth_blocked server result to blocked_auth instead of pending", async () => {
      insertOutboxEntry(db, { id: "out-ab-1", status: "pending" });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          { id: "out-ab-1", idempotency_key: "inst-1:out-ab-1", status: "auth_blocked", reason: "Token expired" },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "user-1" });

      await replayOutbox(db, pushFn, revalidateFn);

      const entry = db.prepare("SELECT * FROM outbox WHERE id = 'out-ab-1'").get() as OutboxEntryRow;
      expect(entry.status).toBe("blocked_auth");
    });

    it("transitions blocked server result to blocked_auth", async () => {
      insertOutboxEntry(db, { id: "out-ab-2", status: "pending" });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          { id: "out-ab-2", idempotency_key: "inst-1:out-ab-2", status: "blocked", reason: "Account suspended" },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "user-1" });

      await replayOutbox(db, pushFn, revalidateFn);

      const entry = db.prepare("SELECT * FROM outbox WHERE id = 'out-ab-2'").get() as OutboxEntryRow;
      expect(entry.status).toBe("blocked_auth");
    });

    it("stops replay after auth_blocked and leaves later entries pending without sending them", async () => {
      insertOutboxEntry(db, { id: "out-ab-stop-1", status: "pending" });
      insertOutboxEntry(db, { id: "out-ab-stop-2", status: "pending" });

      const pushFn: SyncPushFn = vi.fn().mockImplementation(async (entries: OutboxEntryRow[]) => ({
        results: entries.map((entry, index) =>
          index === 0
            ? { id: entry.id, idempotency_key: entry.idempotency_key, status: "auth_blocked", reason: "Token expired" }
            : { id: entry.id, idempotency_key: entry.idempotency_key, status: "accepted" },
        ),
      }));

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "user-1" });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(pushFn).toHaveBeenCalledTimes(1);
      const pushedEntries = (pushFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as OutboxEntryRow[];
      expect(pushedEntries).toHaveLength(1);
      expect(pushedEntries[0].id).toBe("out-ab-stop-1");
      expect(result.blocked).toBe(2);

      const first = db.prepare("SELECT status FROM outbox WHERE id = 'out-ab-stop-1'").get() as { status: string };
      const second = db.prepare("SELECT status FROM outbox WHERE id = 'out-ab-stop-2'").get() as { status: string };
      expect(first.status).toBe("blocked_auth");
      expect(second.status).toBe("pending");
    });
  });

  describe("missing local conflict timestamp handling", () => {
    it("blocks LWW resolution when local_device_timestamp is null instead of falling back to created_at", async () => {
      insertOutboxEntry(db, {
        id: "out-old-row-1",
        operation_type: "product_update",
        aggregate_type: "product",
        aggregate_id: "prod-old-1",
        status: "pending",
        created_at: "2024-01-01T00:00:00.000Z",
        local_device_timestamp: null,
      });

      const pushFn: SyncPushFn = vi.fn().mockResolvedValue({
        results: [
          {
            id: "out-old-row-1",
            idempotency_key: "inst-1:out-old-row-1",
            status: "conflict",
            reason: "Version mismatch",
            server_version: "2024-01-02T00:00:00.000Z",
          },
        ],
      });

      const revalidateFn: RevalidateFn = vi.fn().mockResolvedValue({ valid: true, user_id: "user-1" });

      const result = await replayOutbox(db, pushFn, revalidateFn);

      expect(result.blocked).toBe(1);
      const entry = db.prepare("SELECT status, server_result FROM outbox WHERE id = 'out-old-row-1'").get() as { status: string; server_result: string | null };
      expect(entry.status).toBe("blocked_conflict");
      expect(entry.server_result).toContain("Version mismatch");
    });
  });
});
