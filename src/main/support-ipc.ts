import { ipcMain } from "electron";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// IPC channel constants
// ---------------------------------------------------------------------------

export const SUPPORT_CHANNELS = {
  LIST_OUTBOX: "outbox:list",
  RETRY_OUTBOX: "outbox:retry",
  RETRY_SALE: "outbox:retry-sale",
  RESOLVE_CONFLICT: "outbox:resolve-conflict",
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
  local_device_timestamp?: string | null;
  manual_fix_reason?: string | null;
  entity_label?: string | null;
}

export interface OutboxRetryResult {
  success: boolean;
  error?: string;
  resetCount?: number;
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register support/reconciliation IPC handlers on the main process.
 */
export function registerSupportIpc(getDb: () => Database.Database): void {
  // -- outbox:list -----------------------------------------------------------
  ipcMain.handle(
    SUPPORT_CHANNELS.LIST_OUTBOX,
    (_event, filter?: { status?: string; aggregateType?: string }): OutboxListItem[] => {
      try {
        const db = getDb();

        let rows: OutboxListItem[];
        if (filter?.status && filter?.aggregateType) {
          rows = db
            .prepare(
              "SELECT * FROM outbox WHERE status = ? AND aggregate_type = ? ORDER BY created_at ASC, rowid ASC",
            )
            .all(filter.status, filter.aggregateType) as OutboxListItem[];
        } else if (filter?.status) {
          rows = db
            .prepare(
              "SELECT * FROM outbox WHERE status = ? ORDER BY created_at ASC, rowid ASC",
            )
            .all(filter.status) as OutboxListItem[];
        } else if (filter?.aggregateType) {
          rows = db
            .prepare(
              "SELECT * FROM outbox WHERE aggregate_type = ? ORDER BY created_at ASC, rowid ASC",
            )
            .all(filter.aggregateType) as OutboxListItem[];
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
    (_event, outboxId: string, opts?: { confirmManualFix?: boolean }): OutboxRetryResult => {
      try {
        const db = getDb();

        const entry = db
          .prepare("SELECT id, status FROM outbox WHERE id = ?")
          .get(outboxId) as { id: string; status: string } | undefined;

        if (!entry) {
          return { success: false, error: "Outbox entry not found" };
        }

        const retryable = ["failed", "retry_wait"];
        const manualFixRetryable = opts?.confirmManualFix === true && entry.status === "manual_fix";

        if (!retryable.includes(entry.status) && !manualFixRetryable) {
          return {
            success: false,
            error: `Cannot retry entry with status "${entry.status}". Only "failed", "retry_wait", and "manual_fix" (with confirmation) entries are retryable.`,
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

  // -- outbox:retry-sale -----------------------------------------------------
  // Retry a sale together with all linked stock adjustments as a single
  // atomic group. Only resets "failed" and "retry_wait" entries.
  ipcMain.handle(
    SUPPORT_CHANNELS.RETRY_SALE,
    (_event, saleId: string): OutboxRetryResult => {
      try {
        const db = getDb();

        const retryableStatuses = ["failed", "retry_wait"];

        // Find the sale outbox entry and linked stock entries
        const saleEntry = db
          .prepare(
            "SELECT id FROM outbox WHERE aggregate_type = 'sale' AND aggregate_id = ? AND status IN (?, ?) LIMIT 1",
          )
          .get(saleId, ...retryableStatuses) as { id: string } | undefined;

        if (!saleEntry) {
          return { success: false, error: "No retryable sale outbox entries found for this sale ID." };
        }

        const now = new Date().toISOString();

        const run = db.transaction(() => {
          let resetCount = 0;

          // Reset the sale entry
          db.prepare(`
            UPDATE outbox
            SET status = 'pending', last_error = NULL, next_retry_at = NULL, updated_at = @now
            WHERE id = @id
          `).run({ id: saleEntry.id, now });
          resetCount += 1;

          // Reset linked stock adjustment entries
          const stockEntries = db
            .prepare(
              `SELECT o.id FROM outbox o
               JOIN stock_movements sm ON sm.id = o.aggregate_id
               WHERE o.aggregate_type = 'stock'
                 AND sm.sale_id = ?
                 AND o.status IN (?, ?)`,
            )
            .all(saleId, ...retryableStatuses) as { id: string }[];

          for (const stockEntry of stockEntries) {
            db.prepare(`
              UPDATE outbox
              SET status = 'pending', last_error = NULL, next_retry_at = NULL, updated_at = @now
              WHERE id = @id
            `).run({ id: stockEntry.id, now });
            resetCount += 1;
          }

          return resetCount;
        });

        const resetCount: number = run();

        return { success: true, resetCount };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : "Unknown error retrying sale outbox entries",
        };
      }
    },
  );

  // -- outbox:resolve-conflict -----------------------------------------------
  // Resolve a blocked_conflict entry: keep_local resets to pending,
  // use_server marks as synced (server version wins).
  ipcMain.handle(
    SUPPORT_CHANNELS.RESOLVE_CONFLICT,
    (_event, outboxId: string, params: { resolution: "keep_local" | "use_server" }): OutboxRetryResult => {
      try {
        const db = getDb();

        const entry = db
          .prepare("SELECT id, status FROM outbox WHERE id = ?")
          .get(outboxId) as { id: string; status: string } | undefined;

        if (!entry) {
          return { success: false, error: "Outbox entry not found" };
        }

        if (entry.status !== "blocked_conflict") {
          return {
            success: false,
            error: `Cannot resolve entry with status "${entry.status}". Only "blocked_conflict" entries can be resolved.`,
          };
        }

        const now = new Date().toISOString();

        if (params.resolution === "keep_local") {
          db.prepare(`
            UPDATE outbox
            SET status = 'pending', last_error = NULL, next_retry_at = NULL, updated_at = @now
            WHERE id = @id
          `).run({ id: outboxId, now });
        } else {
          // use_server — mark as synced (server version wins)
          db.prepare(`
            UPDATE outbox
            SET status = 'synced', synced_at = @now, updated_at = @now
            WHERE id = @id
          `).run({ id: outboxId, now });
        }

        return { success: true };
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : "Unknown error resolving conflict",
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
  ipcMain.removeHandler(SUPPORT_CHANNELS.RETRY_SALE);
  ipcMain.removeHandler(SUPPORT_CHANNELS.RESOLVE_CONFLICT);
  ipcMain.removeHandler(SUPPORT_CHANNELS.EXPORT_OUTBOX);
}
