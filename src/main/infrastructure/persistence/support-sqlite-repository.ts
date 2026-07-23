// ---------------------------------------------------------------------------
// Infrastructure: SupportSqliteRepository
//
// SQLite implementation of ISupportRepository. Preserves legacy SQL,
// expected failure results, status gates, retry-sale transaction, and conflict
// branches from src/main/support-ipc.ts exactly.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";
import type { ISupportRepository } from "../../domain/support/support-repository";
import type {
  OutboxListFilter,
  OutboxListItem,
  OutboxRetryResult,
  ResolveConflictParams,
  RetryOutboxOptions,
} from "../../domain/support/support";

export class SupportSqliteRepository implements ISupportRepository {
  constructor(private readonly getDb: () => Database.Database) {}

  // -----------------------------------------------------------------------
  // listOutbox
  // -----------------------------------------------------------------------

  listOutbox(filter?: OutboxListFilter): OutboxListItem[] {
    const db = this.getDb();

    if (filter?.status && filter?.aggregateType) {
      return db
        .prepare(
          "SELECT * FROM outbox WHERE status = ? AND aggregate_type = ? ORDER BY created_at ASC, rowid ASC",
        )
        .all(filter.status, filter.aggregateType) as OutboxListItem[];
    }

    if (filter?.status) {
      return db
        .prepare("SELECT * FROM outbox WHERE status = ? ORDER BY created_at ASC, rowid ASC")
        .all(filter.status) as OutboxListItem[];
    }

    if (filter?.aggregateType) {
      return db
        .prepare(
          "SELECT * FROM outbox WHERE aggregate_type = ? ORDER BY created_at ASC, rowid ASC",
        )
        .all(filter.aggregateType) as OutboxListItem[];
    }

    return db
      .prepare("SELECT * FROM outbox ORDER BY created_at ASC, rowid ASC")
      .all() as OutboxListItem[];
  }

  // -----------------------------------------------------------------------
  // retryOutbox
  // -----------------------------------------------------------------------

  retryOutbox(outboxId: string, opts?: RetryOutboxOptions): OutboxRetryResult {
    const db = this.getDb();

    const entry = db
      .prepare("SELECT id, status FROM outbox WHERE id = ?")
      .get(outboxId) as { id: string; status: string } | undefined;

    if (!entry) {
      return { success: false, error: "Outbox entry not found" };
    }

    const retryable = ["failed", "retry_wait"];
    const manualFixRetryable =
      opts?.confirmManualFix === true && entry.status === "manual_fix";

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
  }

  // -----------------------------------------------------------------------
  // retrySale
  // -----------------------------------------------------------------------

  retrySale(saleId: string): OutboxRetryResult {
    const db = this.getDb();

    const retryableStatuses = ["failed", "retry_wait"];

    // Find the sale outbox entry
    const saleEntry = db
      .prepare(
        "SELECT id FROM outbox WHERE aggregate_type = 'sale' AND aggregate_id = ? AND status IN (?, ?) LIMIT 1",
      )
      .get(saleId, ...retryableStatuses) as { id: string } | undefined;

    if (!saleEntry) {
      return {
        success: false,
        error: "No retryable sale outbox entries found for this sale ID.",
      };
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
  }

  // -----------------------------------------------------------------------
  // resolveConflict
  // -----------------------------------------------------------------------

  resolveConflict(
    outboxId: string,
    params: ResolveConflictParams,
  ): OutboxRetryResult {
    const db = this.getDb();

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
  }

  // -----------------------------------------------------------------------
  // exportOutbox
  // -----------------------------------------------------------------------

  exportOutbox(): OutboxListItem[] {
    const db = this.getDb();
    return db
      .prepare("SELECT * FROM outbox ORDER BY created_at ASC, rowid ASC")
      .all() as OutboxListItem[];
  }
}
