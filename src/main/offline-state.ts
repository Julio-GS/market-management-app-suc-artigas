// ---------------------------------------------------------------------------
// Offline state types — shared contract between main process, IPC, and preload
// ---------------------------------------------------------------------------

export type ConnectivityState = "online" | "offline" | "unknown";

export type BootstrapStatus = "pending" | "in_progress" | "complete" | "failed";

export type SyncStatus = "idle" | "syncing" | "error";

export interface OfflineState {
  /** Whether the local store is bootstrapped and ready for offline operation. */
  ready: boolean;

  /** Current bootstrap phase. */
  bootstrap: BootstrapStatus;

  /** Network reachability assessment. */
  connectivity: ConnectivityState;

  /** Current sync engine status. */
  sync: SyncStatus;

  /** Number of outbox entries waiting for sync. */
  pendingCount: number;

  /** Number of outbox entries that have permanently failed. */
  failureCount: number;

  /** Whether the database is running in degraded/recovery mode. */
  degraded: boolean;

  /** ISO-8601 timestamp of last successful sync, or null if never synced. */
  lastSyncAt: string | null;
}

// ---------------------------------------------------------------------------
// Initial state factory — used before bootstrap or when DB is unavailable
// ---------------------------------------------------------------------------

export const INITIAL_OFFLINE_STATE: OfflineState = {
  ready: false,
  bootstrap: "pending",
  connectivity: "unknown",
  sync: "idle",
  pendingCount: 0,
  failureCount: 0,
  degraded: false,
  lastSyncAt: null,
};

// ---------------------------------------------------------------------------
// State query helpers — operate on the metadata table created by migrations
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";

/**
 * Read the current offline state from the metadata table.
 * Returns a default pre-bootstrap state if the metadata table is missing
 * (which means migrations haven't run yet).
 */
export function getOfflineState(db: Database.Database): OfflineState {
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'",
    )
    .get();

  if (!tableExists) {
    return { ...INITIAL_OFFLINE_STATE };
  }

  const rows = db
    .prepare("SELECT key, value FROM metadata")
    .all() as { key: string; value: string }[];

  const map = new Map(rows.map((r) => [r.key, r.value]));

  const bootstrap = map.get("bootstrap_status") ?? "pending";
  const lastSyncAt = map.get("last_sync_at") || null;
  const degraded = map.get("degraded") === "1";

  // Count outbox entries for pending/failure counts
  const outboxTableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='outbox'",
    )
    .get();

  let pendingCount = 0;
  let failureCount = 0;

  if (outboxTableExists) {
    const counts = db
      .prepare(
        `SELECT
           COALESCE(SUM(CASE WHEN status IN ('pending','in_flight','retry_wait','blocked_auth','blocked_conflict') THEN 1 ELSE 0 END), 0) AS pending,
           COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
         FROM outbox`,
      )
      .get() as { pending: number; failed: number };

    pendingCount = counts.pending;
    failureCount = counts.failed;
  }

  return {
    ready: bootstrap === "complete" && !degraded,
    bootstrap: bootstrap as BootstrapStatus,
    connectivity: "unknown", // set externally by connectivity monitor
    sync: "idle", // set externally by sync engine
    pendingCount,
    failureCount,
    degraded,
    lastSyncAt,
  };
}
