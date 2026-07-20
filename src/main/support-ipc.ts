import { ipcMain } from "electron";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// IPC channel constants
// ---------------------------------------------------------------------------

export const SUPPORT_CHANNELS = {
  LIST_OUTBOX: "outbox:list",
  RETRY_OUTBOX: "outbox:retry",
  EXPORT_OUTBOX: "outbox:export",
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutboxListItem {
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

export interface OutboxRetryResult {
  success: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register support/reconciliation IPC handlers on the main process.
 *
 * `getDb` provides the current database instance so handlers never hold a
 * stale reference.
 */
export function registerSupportIpc(getDb: () => Database.Database): void {
  // -- outbox:list -----------------------------------------------------------
  ipcMain.handle(
    SUPPORT_CHANNELS.LIST_OUTBOX,
    (_event, filter?: { status?: string }): OutboxListItem[] => {
      try {
        const db = getDb();

        let rows: OutboxListItem[];
        if (filter?.status) {
          rows = db
            .prepare(
              "SELECT * FROM outbox WHERE status = ? ORDER BY created_at ASC, rowid ASC",
            )
            .all(filter.status) as OutboxListItem[];
        } else {
          rows = db
            .prepare("SELECT * FROM outbox ORDER BY created_at ASC, rowid ASC")
            .all() as OutboxListItem[];
        }

        return rows;
      } catch {
        return [];
      }
    },
  );

  // -- outbox:retry ----------------------------------------------------------
  ipcMain.handle(
    SUPPORT_CHANNELS.RETRY_OUTBOX,
    (_event, outboxId: string): OutboxRetryResult => {
      try {
        const db = getDb();

        const entry = db
          .prepare("SELECT id, status FROM outbox WHERE id = ?")
          .get(outboxId) as { id: string; status: string } | undefined;

        if (!entry) {
          return { success: false, error: "Outbox entry not found" };
        }

        // Only reset entries that are in a terminal/blocked state back to pending.
        // Already-synced entries should not be retried.
        const terminallyFailed = ["failed", "blocked_auth", "blocked_conflict"];
        if (!terminallyFailed.includes(entry.status)) {
          return {
            success: false,
            error: `Cannot retry entry with status "${entry.status}"`,
          };
        }

        const now = new Date().toISOString();
        db.prepare(
          `UPDATE outbox
           SET status = 'pending',
               last_error = NULL,
               next_retry_at = NULL,
               updated_at = @now
           WHERE id = @id`,
        ).run({ id: outboxId, now });

        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : "Unknown error retrying outbox entry",
        };
      }
    },
  );

  // -- outbox:export ---------------------------------------------------------
  ipcMain.handle(
    SUPPORT_CHANNELS.EXPORT_OUTBOX,
    (): OutboxListItem[] => {
      try {
        const db = getDb();
        return db
          .prepare("SELECT * FROM outbox ORDER BY created_at ASC, rowid ASC")
          .all() as OutboxListItem[];
      } catch {
        return [];
      }
    },
  );
}

/**
 * Remove all support IPC handlers.
 */
export function unregisterSupportIpc(): void {
  ipcMain.removeHandler(SUPPORT_CHANNELS.LIST_OUTBOX);
  ipcMain.removeHandler(SUPPORT_CHANNELS.RETRY_OUTBOX);
  ipcMain.removeHandler(SUPPORT_CHANNELS.EXPORT_OUTBOX);
}
