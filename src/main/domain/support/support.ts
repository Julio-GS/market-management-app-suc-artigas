// ---------------------------------------------------------------------------
// Domain: Support types
//
// Pure Support/outbox types: list item, retry result, filter, conflict params.
// Does not import Electron, SQLite, application, adapter, or infrastructure.
// Snake_case names are preserved from the legacy outbox row contract.
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

export interface OutboxListFilter {
  status?: string;
  aggregateType?: string;
}

export interface RetryOutboxOptions {
  confirmManualFix?: boolean;
}

export interface ResolveConflictParams {
  resolution: "keep_local" | "use_server";
}
