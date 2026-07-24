// ---------------------------------------------------------------------------
// Compatibility facade for src/main/sync-engine
//
// All implementation has been extracted into explicit sync-engine/ modules.
// This file re-exports the public surface for existing callers and tests.
// ---------------------------------------------------------------------------

// Types
export type {
  OutboxEntryRow,
  SyncPushResult,
  SyncPushResponse,
  RevalidateResult,
  SyncPushFn,
  RevalidateFn,
  ReplayResult,
  OutboxStatusCounts,
} from "./sync-engine/types";

// LWW policy
export { resolveLww, resolveProductLww } from "./sync-engine/lww-policy";

// Revalidation flag helpers
export {
  markRevalidateRequired,
  clearRevalidateRequired,
  isRevalidationRequired,
} from "./sync-engine/revalidation-flags";

// Count helpers
export {
  getPendingOutboxCount,
  getFailedOutboxCount,
  getOutboxStatusCounts,
} from "./sync-engine/outbox-status";

// Outbox entry status update
export type { MarkOutboxOptions } from "./sync-engine/outbox-entry-status";
export {
  recoverStaleInFlightEntries,
  markOutboxEntry,
} from "./sync-engine/outbox-entry-status";

// Ordered replay orchestration
export { replayOutbox } from "./sync-engine/replay-outbox";
