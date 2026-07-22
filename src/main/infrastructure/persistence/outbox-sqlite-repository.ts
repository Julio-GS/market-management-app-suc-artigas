// ---------------------------------------------------------------------------
// Infrastructure: Outbox SQLite repository
//
// Implements IOutboxRepository using better-sqlite3. Participates in the
// caller's transaction via the injected getDb() connection — it does NOT
// start its own transaction.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { IOutboxRepository, OutboxEntryInput } from "../../ports/outbox-repository";

export class OutboxSqliteRepository implements IOutboxRepository {
  constructor(private readonly getDb: () => Database.Database) {}

  enqueue(entry: OutboxEntryInput): void {
    const db = this.getDb();
    const outboxId = randomUUID();
    const idempotencyKey = `${entry.installationId}:${outboxId}`;

    db.prepare(`
      INSERT INTO outbox
        (id, idempotency_key, operation_type, aggregate_type, aggregate_id,
         payload, status, attempt_count, created_at, updated_at,
         local_device_timestamp, actor_user_id, entity_label)
      VALUES
        (@id, @idempotency_key, @operation_type, @aggregate_type, @aggregate_id,
         @payload, 'pending', 0, @created_at, @created_at,
         @local_device_timestamp, @actor_user_id, @entity_label)
    `).run({
      id: outboxId,
      idempotency_key: idempotencyKey,
      operation_type: entry.operationType,
      aggregate_type: entry.aggregateType,
      aggregate_id: entry.aggregateId,
      payload: JSON.stringify(entry.payload),
      created_at: entry.createdAt,
      local_device_timestamp: entry.createdAt,
      actor_user_id: entry.actorUserId,
      entity_label: entry.entityLabel,
    });
  }
}
