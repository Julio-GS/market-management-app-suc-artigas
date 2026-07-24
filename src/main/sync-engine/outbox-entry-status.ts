// ---------------------------------------------------------------------------
// Outbox entry status update helpers
//
// Extracted from src/main/sync-engine.ts — SQL preserved verbatim.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";

export interface MarkOutboxOptions {
  status: string;
  last_error?: string | null;
  server_result?: string | null;
  synced_at?: string | null;
  manual_fix_reason?: string | null;
}

/**
 * Reset any outbox entries that are still `in_flight` back to `pending`.
 * This should be called on startup / DB init to recover from a crash that
 * interrupted an in-progress replay.
 *
 * Returns the number of recovered entries.
 */
export function recoverStaleInFlightEntries(db: Database.Database): number {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE outbox
    SET status = 'pending',
        updated_at = @now
    WHERE status = 'in_flight'
  `).run({ now });
  return result.changes;
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
      manual_fix_reason = CASE WHEN @manual_fix_reason IS NOT NULL THEN @manual_fix_reason ELSE manual_fix_reason END,
      synced_at = CASE WHEN @synced_at IS NOT NULL THEN @synced_at ELSE synced_at END,
      attempt_count = attempt_count + 1,
      updated_at = @now
    WHERE id = @id
  `).run({
    id: outboxId,
    status: opts.status,
    last_error: opts.last_error ?? null,
    server_result: opts.server_result ?? null,
    manual_fix_reason: opts.manual_fix_reason ?? null,
    synced_at: opts.synced_at ?? null,
    now,
  });
}
