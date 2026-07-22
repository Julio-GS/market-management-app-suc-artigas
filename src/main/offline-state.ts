// ---------------------------------------------------------------------------
// Offline state types — shared contract between main process, IPC, and preload
// ---------------------------------------------------------------------------

export type ConnectivityState = "online" | "offline" | "unknown" | "reconnecting";

export type BootstrapStatus = "pending" | "in_progress" | "complete" | "failed";

export type SyncStatus = "idle" | "syncing" | "error";

export interface StatusCounts {
  pending: number;
  in_flight: number;
  failed: number;
  retry_wait: number;
  blocked_auth: number;
  blocked_conflict: number;
  manual_fix: number;
  synced: number;
}

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

  /** Counts by outbox status for richer UI sync-state display. */
  statusCounts: StatusCounts;
}

// ---------------------------------------------------------------------------
// Initial state factory — used before bootstrap or when DB is unavailable
// ---------------------------------------------------------------------------

const EMPTY_STATUS_COUNTS: StatusCounts = {
  pending: 0,
  in_flight: 0,
  failed: 0,
  retry_wait: 0,
  blocked_auth: 0,
  blocked_conflict: 0,
  manual_fix: 0,
  synced: 0,
};

export const INITIAL_OFFLINE_STATE: OfflineState = {
  ready: false,
  bootstrap: "pending",
  connectivity: "unknown",
  sync: "idle",
  pendingCount: 0,
  failureCount: 0,
  degraded: false,
  lastSyncAt: null,
  statusCounts: { ...EMPTY_STATUS_COUNTS },
};

// ---------------------------------------------------------------------------
// State query helpers — operate on the metadata table created by migrations
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";

/**
 * Read the current offline state from the metadata table.
 *
 * The optional `connectivity` parameter allows the connectivity monitor to
 * inject the current network state. When omitted, connectivity defaults to
 * `"unknown"`.
 */
export function getOfflineState(
  db: Database.Database,
  connectivity?: ConnectivityState,
): OfflineState {
  const tableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'",
    )
    .get();

  if (!tableExists) {
    return { ...INITIAL_OFFLINE_STATE, connectivity: connectivity ?? "unknown" };
  }

  const rows = db
    .prepare("SELECT key, value FROM metadata")
    .all() as { key: string; value: string }[];

  const map = new Map(rows.map((r) => [r.key, r.value]));

  const bootstrap = map.get("bootstrap_status") ?? "pending";
  const lastSyncAt = map.get("last_sync_at") || null;
  const degraded = map.get("degraded") === "1";

  // Count outbox entries for pending/failure/status counts
  const outboxTableExists = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='outbox'",
    )
    .get();

  let pendingCount = 0;
  let failureCount = 0;
  let statusCounts: StatusCounts = { ...EMPTY_STATUS_COUNTS };

  if (outboxTableExists) {
    const statusRows = db
      .prepare("SELECT status, COUNT(*) as cnt FROM outbox GROUP BY status")
      .all() as { status: string; cnt: number }[];

    const byStatus = new Map(statusRows.map((r) => [r.status, r.cnt]));

    statusCounts = {
      pending: byStatus.get("pending") ?? 0,
      in_flight: byStatus.get("in_flight") ?? 0,
      failed: byStatus.get("failed") ?? 0,
      retry_wait: byStatus.get("retry_wait") ?? 0,
      blocked_auth: byStatus.get("blocked_auth") ?? 0,
      blocked_conflict: byStatus.get("blocked_conflict") ?? 0,
      manual_fix: byStatus.get("manual_fix") ?? 0,
      synced: byStatus.get("synced") ?? 0,
    };

    pendingCount =
      statusCounts.pending +
      statusCounts.in_flight +
      statusCounts.retry_wait +
      statusCounts.blocked_auth +
      statusCounts.blocked_conflict;
    failureCount = statusCounts.failed;
  }

  return {
    ready: bootstrap === "complete" && !degraded,
    bootstrap: bootstrap as BootstrapStatus,
    connectivity: connectivity ?? "unknown",
    sync: "idle",
    pendingCount,
    failureCount,
    degraded,
    lastSyncAt,
    statusCounts,
  };
}
