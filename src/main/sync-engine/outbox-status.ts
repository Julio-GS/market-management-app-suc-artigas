// ---------------------------------------------------------------------------
// Outbox status count helpers
//
// Extracted from src/main/sync-engine.ts — SQL preserved verbatim.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";
import type { OutboxStatusCounts } from "./types";

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

/**
 * Return a count for every recognized outbox status so that sync-state
 * consumers can display pending, in_flight, retry_wait, blocked_auth,
 * blocked_conflict, manual_fix, failed, and synced counts.
 */
export function getOutboxStatusCounts(db: Database.Database): OutboxStatusCounts {
  const rows = db
    .prepare("SELECT status, COUNT(*) as cnt FROM outbox GROUP BY status")
    .all() as { status: string; cnt: number }[];

  const byStatus = new Map(rows.map((r) => [r.status, r.cnt]));

  return {
    pending: byStatus.get("pending") ?? 0,
    in_flight: byStatus.get("in_flight") ?? 0,
    failed: byStatus.get("failed") ?? 0,
    retry_wait: byStatus.get("retry_wait") ?? 0,
    blocked_auth: byStatus.get("blocked_auth") ?? 0,
    blocked_conflict: byStatus.get("blocked_conflict") ?? 0,
    manual_fix: byStatus.get("manual_fix") ?? 0,
    synced: byStatus.get("synced") ?? 0,
  };
}
