import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutboxEntryRow {
  id: string;
  idempotency_key: string;
  operation_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: string;
  status: string;
  base_server_version: string | null;
  actor_user_id: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  last_error: string | null;
  server_result: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
}

export interface SyncPushResult {
  id: string;
  idempotency_key: string;
  status: string;
  server_id?: string | null;
  server_version?: string | null;
  reason?: string | null;
}

export interface SyncPushResponse {
  results: SyncPushResult[];
}

export interface RevalidateResult {
  valid: boolean;
  user_id: string;
  username?: string;
  reason?: string;
}

export type SyncPushFn = (
  entries: OutboxEntryRow[],
) => Promise<SyncPushResponse>;

export type RevalidateFn = (userId: string) => Promise<RevalidateResult>;

export interface ReplayResult {
  synced: number;
  failed: number;
  blocked: number;
  skipped: number;
  revalidationBlocked: boolean;
}

// ---------------------------------------------------------------------------
// Metadata keys
// ---------------------------------------------------------------------------

const META_REVALIDATE = "revalidation_required";

// ---------------------------------------------------------------------------
// Revalidation flag helpers
// ---------------------------------------------------------------------------

/**
 * Mark that auth revalidation is required before the next privileged sync.
 */
export function markRevalidateRequired(db: Database.Database): void {
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, '1')",
  ).run(META_REVALIDATE);
}

/**
 * Clear the revalidation-required flag after successful revalidation.
 */
export function clearRevalidateRequired(db: Database.Database): void {
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, '0')",
  ).run(META_REVALIDATE);
}

/**
 * Check whether auth revalidation is required before sync.
 */
export function isRevalidationRequired(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(META_REVALIDATE) as { value: string } | undefined;
  return row?.value === "1";
}

// ---------------------------------------------------------------------------
// Count helpers
// ---------------------------------------------------------------------------

export function getPendingOutboxCount(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'pending'")
    .get() as { c: number };
  return row.c;
}

export function getFailedOutboxCount(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'failed'")
    .get() as { c: number };
  return row.c;
}

// ---------------------------------------------------------------------------
// Outbox entry status update
// ---------------------------------------------------------------------------

export interface MarkOutboxOptions {
  status: string;
  last_error?: string | null;
  server_result?: string | null;
  synced_at?: string | null;
}

/**
 * Update a single outbox entry's status and related fields atomically.
 * Increments `attempt_count` on every call.
 */
export function markOutboxEntry(
  db: Database.Database,
  outboxId: string,
  opts: MarkOutboxOptions,
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE outbox
    SET
      status = @status,
      last_error = @last_error,
      server_result = @server_result,
      synced_at = CASE WHEN @synced_at IS NOT NULL THEN @synced_at ELSE synced_at END,
      attempt_count = attempt_count + 1,
      updated_at = @now
    WHERE id = @id
  `).run({
    id: outboxId,
    status: opts.status,
    last_error: opts.last_error ?? null,
    server_result: opts.server_result ?? null,
    synced_at: opts.synced_at ?? null,
    now,
  });
}

// ---------------------------------------------------------------------------
// Ordered outbox replay
// ---------------------------------------------------------------------------

/**
 * Replay pending outbox entries in order.
 *
 * - Skips already-synced/failed entries.
 * - If auth revalidation is required, runs `revalidateFn` first.
 * - Pushes pending entries in a batch via `pushFn`.
 * - On failure, marks the failing entry and stops; later entries stay pending.
 * - On success, marks each entry as synced with server metadata.
 */
export async function replayOutbox(
  db: Database.Database,
  pushFn: SyncPushFn,
  revalidateFn: RevalidateFn,
): Promise<ReplayResult> {
  const result: ReplayResult = {
    synced: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    revalidationBlocked: false,
  };

  // -------------------------------------------------------------------
  // 1. Auth revalidation gate
  // -------------------------------------------------------------------
  if (isRevalidationRequired(db)) {
    // Use a known user ID from the offline_sessions table
    const session = db
      .prepare("SELECT user_id FROM offline_sessions LIMIT 1")
      .get() as { user_id: string } | undefined;

    if (!session) {
      result.revalidationBlocked = true;
      return result;
    }

    const reval = await revalidateFn(session.user_id);
    if (!reval.valid) {
      result.revalidationBlocked = true;

      // Mark all pending entries as blocked_auth
      db.prepare(`
        UPDATE outbox
        SET status = 'blocked_auth',
            last_error = @reason,
            updated_at = @now
        WHERE status = 'pending'
      `).run({
        reason: reval.reason ?? "Auth revalidation failed",
        now: new Date().toISOString(),
      });

      return result;
    }

    clearRevalidateRequired(db);
  }

  // -------------------------------------------------------------------
  // 2. Collect pending entries in order
  // -------------------------------------------------------------------
  const pending = db
    .prepare(
      "SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC",
    )
    .all() as OutboxEntryRow[];

  if (pending.length === 0) {
    return result;
  }

  // -------------------------------------------------------------------
  // 3. Mark collected entries as in_flight before pushing
  // -------------------------------------------------------------------
  const now = new Date().toISOString();
  const markInFlight = db.prepare(`
    UPDATE outbox
    SET status = 'in_flight', updated_at = ?
    WHERE id = ?
  `);
  for (const e of pending) {
    markInFlight.run(now, e.id);
  }

  // -------------------------------------------------------------------
  // 4. Push batch
  // -------------------------------------------------------------------
  let pushResponse: SyncPushResponse;
  try {
    pushResponse = await pushFn(pending);
  } catch (err) {
    // Network-level failure — mark all as retry_wait
    const reason = err instanceof Error ? err.message : String(err);
    for (const entry of pending) {
      markOutboxEntry(db, entry.id, {
        status: "retry_wait",
        last_error: reason,
      });
    }
    result.failed = pending.length;
    return result;
  }

  // -------------------------------------------------------------------
  // 5. Process per-entry results
  // -------------------------------------------------------------------
  let blocked = false;

  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    const entryResult = pushResponse.results[i];

    if (blocked) {
      // Later entries remain pending
      markOutboxEntry(db, entry.id, {
        status: "pending",
        last_error: "Blocked by a previous entry failure.",
      });
      result.blocked += 1;
      continue;
    }

    if (!entryResult) {
      markOutboxEntry(db, entry.id, {
        status: "failed",
        last_error: "No result returned from server for this entry.",
      });
      result.failed += 1;
      blocked = true;
      continue;
    }

    switch (entryResult.status) {
      case "accepted":
      case "duplicate":
        markOutboxEntry(db, entry.id, {
          status: "synced",
          synced_at: new Date().toISOString(),
          server_result: JSON.stringify(entryResult),
        });
        result.synced += 1;
        break;

      case "conflict":
      case "validation_error":
        markOutboxEntry(db, entry.id, {
          status: "failed",
          last_error: entryResult.reason ?? "Server rejected the operation.",
          server_result: JSON.stringify(entryResult),
        });
        result.failed += 1;
        blocked = true;
        break;

      case "transient_error":
        markOutboxEntry(db, entry.id, {
          status: "retry_wait",
          last_error: entryResult.reason ?? "Transient server error.",
          server_result: JSON.stringify(entryResult),
        });
        result.failed += 1;
        blocked = true;
        break;

      case "auth_blocked":
      case "blocked":
        markOutboxEntry(db, entry.id, {
          status: "pending",
          last_error: entryResult.reason ?? "Blocked by server.",
        });
        result.blocked += 1;
        break;

      default:
        markOutboxEntry(db, entry.id, {
          status: "failed",
          last_error: `Unknown server status: ${entryResult.status}`,
        });
        result.failed += 1;
        blocked = true;
    }
  }

  return result;
}
