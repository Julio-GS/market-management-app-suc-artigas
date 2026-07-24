// ---------------------------------------------------------------------------
// Domain: ISupportRepository port
//
// One port method per existing IPC operation. No extra methods. No shared
// outbox abstractions, no generic sync helpers.
// ---------------------------------------------------------------------------

import type {
  OutboxListFilter,
  OutboxListItem,
  OutboxRetryResult,
  ResolveConflictParams,
  RetryOutboxOptions,
} from "./support";

export interface ISupportRepository {
  listOutbox(filter?: OutboxListFilter): OutboxListItem[];
  retryOutbox(outboxId: string, opts?: RetryOutboxOptions): OutboxRetryResult;
  retrySale(saleId: string): OutboxRetryResult;
  resolveConflict(outboxId: string, params: ResolveConflictParams): OutboxRetryResult;
  exportOutbox(): OutboxListItem[];
}
