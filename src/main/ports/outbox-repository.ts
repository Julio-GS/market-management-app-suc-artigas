// ---------------------------------------------------------------------------
// Ports: Outbox repository contract
//
// Cross-cutting port consumed by domain/application code and implemented by
// infrastructure adapters. Must NOT import Electron, better-sqlite3, or any
// concrete adapter.
// ---------------------------------------------------------------------------

export interface OutboxEntryInput {
  operationType: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  createdAt: string;
  installationId: string;
  actorUserId: string | null;
  entityLabel: string;
}

export interface IOutboxRepository {
  enqueue(entry: OutboxEntryInput): void;
}
