// ---------------------------------------------------------------------------
// Application: SupportService
//
// Thin use-case boundary delegating 1:1 to ISupportRepository.
// Does not validate statuses, catch errors, access SQLite, or map IPC errors.
// ---------------------------------------------------------------------------

import type { ISupportRepository } from "../../domain/support/support-repository";
import type {
  OutboxListFilter,
  OutboxListItem,
  OutboxRetryResult,
  ResolveConflictParams,
  RetryOutboxOptions,
} from "../../domain/support/support";

export class SupportService {
  constructor(private readonly supportRepository: ISupportRepository) {}

  listOutbox(filter?: OutboxListFilter): OutboxListItem[] {
    return this.supportRepository.listOutbox(filter);
  }

  retryOutbox(outboxId: string, opts?: RetryOutboxOptions): OutboxRetryResult {
    return this.supportRepository.retryOutbox(outboxId, opts);
  }

  retrySale(saleId: string): OutboxRetryResult {
    return this.supportRepository.retrySale(saleId);
  }

  resolveConflict(outboxId: string, params: ResolveConflictParams): OutboxRetryResult {
    return this.supportRepository.resolveConflict(outboxId, params);
  }

  exportOutbox(): OutboxListItem[] {
    return this.supportRepository.exportOutbox();
  }
}
