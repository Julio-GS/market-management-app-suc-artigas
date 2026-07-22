import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import {
  getPendingOutboxCount,
  getFailedOutboxCount,
  getOutboxStatusCounts,
  isRevalidationRequired,
  replayOutbox,
  type ReplayResult,
  type OutboxStatusCounts,
  type SyncPushFn,
  type RevalidateFn,
  type SyncPushResponse,
} from "./sync-engine";
import {
  pullAndApply,
  type PullResult,
  type PullResponse,
} from "./pull-reconciliation";

// ---------------------------------------------------------------------------
// IPC channel constants
// ---------------------------------------------------------------------------

export const SYNC_CHANNELS = {
  START_SYNC: "sync:start",
  GET_SYNC_STATE: "sync:get-state",
  PULL: "sync:pull",
} as const;

export interface SyncStatePayload {
  pendingCount: number;
  failedCount: number;
  inFlightCount: number;
  retryWaitCount: number;
  blockedAuthCount: number;
  blockedConflictCount: number;
  manualFixCount: number;
  revalidationRequired: boolean;
  lastSyncAt: string | null;
}

// ---------------------------------------------------------------------------
// Pull function factory
// ---------------------------------------------------------------------------

/**
 * Build a `pullFn` that calls the backend sync/pull endpoint from the main
 * process.  The caller is responsible for injecting a valid auth token and
 * the backend base URL.
 */
function createBackendPullFn(
  apiBaseUrl: string,
  token: string,
): (cursor?: string) => Promise<PullResponse> {
  const base = apiBaseUrl.replace(/\/+$/, "");
  const url = `${base}/sync/pull`;

  return async (cursor?: string): Promise<PullResponse> => {
    const params = new URLSearchParams();
    if (cursor) params.set("cursor", cursor);

    const fetchUrl = `${url}?${params.toString()}`;
    const response = await fetch(fetchUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`Pull request failed: ${response.status} ${response.statusText}`);
    }

    return (await response.json()) as PullResponse;
  };
}

// ---------------------------------------------------------------------------
// Push function factory (Slice 6: wired from stub)
// ---------------------------------------------------------------------------

/**
 * Build a `pushFn` that calls the backend sync/push endpoint from the main
 * process.  The caller is responsible for injecting a valid auth token and
 * the backend base URL.
 */
export function createBackendPushFn(
  apiBaseUrl: string,
  token: string,
): SyncPushFn {
  const base = apiBaseUrl.replace(/\/+$/, "");

  return async (entries) => {
    const response = await fetch(`${base}/sync/push`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        entries: entries.map((e) => ({
          id: e.id,
          idempotency_key: e.idempotency_key,
          operation_type: e.operation_type,
          aggregate_type: e.aggregate_type,
          aggregate_id: e.aggregate_id,
          payload: JSON.parse(e.payload),
          base_server_version: e.base_server_version,
          actor_user_id: e.actor_user_id,
          created_at: e.created_at,
        })),
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Push request failed: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as SyncPushResponse;
  };
}

/**
 * Build a `revalidateFn` that calls the backend auth/revalidate endpoint.
 */
function createBackendRevalidateFn(
  apiBaseUrl: string,
  token: string,
): RevalidateFn {
  const base = apiBaseUrl.replace(/\/+$/, "");

  return async (userId) => {
    const response = await fetch(`${base}/auth/revalidate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ user_id: userId }),
    });

    if (!response.ok) {
      return {
        valid: false,
        user_id: userId,
        reason: `Revalidation failed: ${response.status}`,
      };
    }

    return (await response.json()) as {
      valid: boolean;
      user_id: string;
      username?: string;
      reason?: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register sync-related IPC handlers on the main process.
 *
 * `getDb` provides the current database instance so handlers never hold a
 * stale reference.
 * `onSyncAuth` is an optional callback that receives the latest auth params
 * so the connectivity listener can re-use them for automatic reconnect sync.
 */
export function registerSyncIpc(
  getDb: () => Database.Database,
  onSyncAuth?: (params: { apiBaseUrl: string; token: string }) => void,
): void {
  // -- sync:get-state --------------------------------------------------------
  ipcMain.handle(SYNC_CHANNELS.GET_SYNC_STATE, (): SyncStatePayload => {
    try {
      const db = getDb();
      const lastSyncRow = db
        .prepare("SELECT value FROM metadata WHERE key = 'last_sync_at'")
        .get() as { value: string } | undefined;

      const counts = getOutboxStatusCounts(db);

      return {
        pendingCount: counts.pending,
        failedCount: counts.failed,
        inFlightCount: counts.in_flight,
        retryWaitCount: counts.retry_wait,
        blockedAuthCount: counts.blocked_auth,
        blockedConflictCount: counts.blocked_conflict,
        manualFixCount: counts.manual_fix,
        revalidationRequired: isRevalidationRequired(db),
        lastSyncAt: lastSyncRow?.value || null,
      };
    } catch {
      return {
        pendingCount: 0,
        failedCount: 0,
        inFlightCount: 0,
        retryWaitCount: 0,
        blockedAuthCount: 0,
        blockedConflictCount: 0,
        manualFixCount: 0,
        revalidationRequired: false,
        lastSyncAt: null,
      };
    }
  });

  // -- sync:start ------------------------------------------------------------
  // Manual sync trigger.  Accepts optional auth context from the renderer.
  // Pushes pending outbox entries to the backend, then pulls server
  // authoritative changes only when push is not blocked.
  ipcMain.handle(
    SYNC_CHANNELS.START_SYNC,
    async (
      _event,
      params?: { apiBaseUrl?: string; token?: string },
    ): Promise<ReplayResult> => {
      try {
        const db = getDb();

        // Push outbox entries when auth context is available
        let pushResult: ReplayResult = {
          synced: 0,
          failed: 0,
          blocked: 0,
          skipped: 0,
          revalidationBlocked: false,
        };

        if (params?.apiBaseUrl && params?.token) {
          // Cache auth for automatic reconnect sync
          onSyncAuth?.({ apiBaseUrl: params.apiBaseUrl, token: params.token });

          const pushFn = createBackendPushFn(params.apiBaseUrl, params.token);
          const revalidateFn = createBackendRevalidateFn(
            params.apiBaseUrl,
            params.token,
          );

          pushResult = await replayOutbox(db, pushFn, revalidateFn);

          // GAP 5: Only pull when push is not blocked by auth, conflict, or manual-fix.
          // Pull reconciliation must not proceed when the push cycle was blocked.
          if (!pushResult.revalidationBlocked && pushResult.blocked === 0) {
            const pullFn = createBackendPullFn(params.apiBaseUrl, params.token);
            await pullAndApply(db, pullFn);
          }
        }

        return pushResult;
      } catch {
        return {
          synced: 0,
          failed: 0,
          blocked: 0,
          skipped: 0,
          revalidationBlocked: false,
        };
      }
    },
  );

  // -- sync:pull -------------------------------------------------------------
  // Pull server-authoritative changes and apply them to local stores.
  // Accepts auth context from the renderer.
  ipcMain.handle(
    SYNC_CHANNELS.PULL,
    async (
      _event,
      params?: { apiBaseUrl?: string; token?: string },
    ): Promise<PullResult> => {
      try {
        const db = getDb();

        if (!params?.apiBaseUrl || !params?.token) {
          return {
            applied: 0,
            skipped: 0,
            cursor: null,
            hasMore: false,
          };
        }

        const pullFn = createBackendPullFn(params.apiBaseUrl, params.token);
        return await pullAndApply(db, pullFn);
      } catch {
        return {
          applied: 0,
          skipped: 0,
          cursor: null,
          hasMore: false,
        };
      }
    },
  );
}

/**
 * Remove all sync IPC handlers.
 */
export function unregisterSyncIpc(): void {
  ipcMain.removeHandler(SYNC_CHANNELS.START_SYNC);
  ipcMain.removeHandler(SYNC_CHANNELS.GET_SYNC_STATE);
  ipcMain.removeHandler(SYNC_CHANNELS.PULL);
}
