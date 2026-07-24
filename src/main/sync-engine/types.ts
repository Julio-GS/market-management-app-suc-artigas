// ---------------------------------------------------------------------------
// Pure sync-engine types
//
// Extracted from src/main/sync-engine.ts — no infrastructure dependencies.
// ---------------------------------------------------------------------------

export interface OutboxEntryRow {
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
  local_device_timestamp: string | null;
  manual_fix_reason: string | null;
  entity_label: string | null;
}

export interface SyncPushResult {
  id: string;
  idempotency_key: string;
  status: string;
  server_id?: string | null;
  server_version?: string | null;
  reason?: string | null;
  server_payload?: Record<string, unknown> | null;
}

export interface SyncPushResponse {
  results: SyncPushResult[];
}

export interface RevalidateResult {
  valid: boolean;
  user_id: string;
  username?: string;
  reason?: string;
}

export type SyncPushFn = (
  entries: OutboxEntryRow[],
) => Promise<SyncPushResponse>;

export type RevalidateFn = (userId: string) => Promise<RevalidateResult>;

export interface ReplayResult {
  synced: number;
  failed: number;
  blocked: number;
  skipped: number;
  revalidationBlocked: boolean;
}

export interface OutboxStatusCounts {
  pending: number;
  in_flight: number;
  failed: number;
  retry_wait: number;
  blocked_auth: number;
  blocked_conflict: number;
  manual_fix: number;
  synced: number;
}
