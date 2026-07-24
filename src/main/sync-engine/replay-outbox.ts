// ---------------------------------------------------------------------------
// Ordered outbox replay orchestration
//
// Extracted from src/main/sync-engine.ts — behavior preserved verbatim.
// Coordinates extracted helpers and offline auth functions.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";
import {
  getOfflineSession,
  unblockAuthEntriesAfterRevalidation,
} from "../offline-auth";
import type {
  OutboxEntryRow,
  SyncPushResult,
  SyncPushFn,
  RevalidateFn,
  ReplayResult,
} from "./types";
import { resolveLww } from "./lww-policy";
import { isRevalidationRequired } from "./revalidation-flags";
import { markOutboxEntry } from "./outbox-entry-status";
import {
  applyServerProductPayload,
  restoreProductFromSnapshot,
} from "./product-payload";
import {
  applyServerPromotionPayload,
  restorePromotionFromSnapshot,
} from "./promotion-payload";
import {
  applyServerProviderPurchasePayload,
  restoreProviderPurchaseFromSnapshot,
} from "./provider-purchase-payload";

/**
 * Replay pending outbox entries in order.
 *
 * - Skips already-synced/failed entries.
 * - If auth revalidation is required, uses `getOfflineSession` (deterministic)
 *   to choose the revalidation actor and runs `revalidateFn` first.
 * - On successful revalidation, calls `unblockAuthEntriesAfterRevalidation`
 *   so previously `blocked_auth` entries for the revalidated actor return to
 *   `pending` for ordered replay.
 * - Pushes pending entries in a batch via `pushFn`.
 * - Processes per-entry results:
 *   - `validation_error` → `manual_fix` (definitive rejection, not retryable);
 *     for `product_delete` restores the product from the `before` snapshot.
 *   - `conflict` for product types → LWW resolution by `local_device_timestamp`:
 *     local wins → re-queue as `pending` with LWW metadata for re-push;
 *     server wins → apply server payload locally, mark `synced`.
 *   - `conflict` for non-product types → `blocked_conflict`
 *   - `conflict` with missing metadata → `blocked_conflict`
 *   - `auth_blocked` / `blocked` → `blocked_auth`
 *   - `transient_error` → `retry_wait`
 * - On blocking failure, marks later entries as pending (not pushed further).
 */
export async function replayOutbox(
  db: Database.Database,
  pushFn: SyncPushFn,
  revalidateFn: RevalidateFn,
): Promise<ReplayResult> {
  const result: ReplayResult = {
    synced: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    revalidationBlocked: false,
  };

  // -------------------------------------------------------------------
  // 1. Auth revalidation gate
  // -------------------------------------------------------------------
  if (isRevalidationRequired(db)) {
    // Use the deterministic most-recently-validated session helper
    const session = getOfflineSession(db);

    if (!session) {
      result.revalidationBlocked = true;
      return result;
    }

    const reval = await revalidateFn(session.user_id);
    if (!reval.valid) {
      result.revalidationBlocked = true;

      // Mark all pending entries as blocked_auth
      db.prepare(`
        UPDATE outbox
        SET status = 'blocked_auth',
            last_error = @reason,
            updated_at = @now
        WHERE status = 'pending'
      `).run({
        reason: reval.reason ?? "Auth revalidation failed",
        now: new Date().toISOString(),
      });

      return result;
    }

    // Unblock previously blocked_auth entries for this actor only
    unblockAuthEntriesAfterRevalidation(db, session.user_id);
  }

  // -------------------------------------------------------------------
  // 2. Collect pending entries in order
  // -------------------------------------------------------------------
  const pending = db
    .prepare(
      "SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC",
    )
    .all() as OutboxEntryRow[];

  if (pending.length === 0) {
    return result;
  }

  // -------------------------------------------------------------------
  // 3. Push entries in order and stop after a blocking result
  // -------------------------------------------------------------------
  const markInFlight = db.prepare(`
    UPDATE outbox
    SET status = 'in_flight', updated_at = ?
    WHERE id = ?
  `);

  let blocked = false;

  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];

    if (blocked) {
      // Later entries remain pending and must not be sent.
      markOutboxEntry(db, entry.id, {
        status: "pending",
        last_error: "Blocked by a previous entry failure.",
      });
      result.blocked += 1;
      continue;
    }

    markInFlight.run(new Date().toISOString(), entry.id);

    let entryResult: SyncPushResult | undefined;
    try {
      const pushResponse = await pushFn([entry]);
      entryResult = pushResponse.results[0];
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      markOutboxEntry(db, entry.id, {
        status: "retry_wait",
        last_error: reason,
      });
      result.failed += 1;
      blocked = true;
      continue;
    }

    if (!entryResult) {
      markOutboxEntry(db, entry.id, {
        status: "failed",
        last_error: "No result returned from server for this entry.",
      });
      result.failed += 1;
      blocked = true;
      continue;
    }

    switch (entryResult.status) {
      case "accepted":
      case "duplicate":
        markOutboxEntry(db, entry.id, {
          status: "synced",
          synced_at: new Date().toISOString(),
          server_result: JSON.stringify(entryResult),
        });
        result.synced += 1;
        break;

      // -- definitive rejection → manual_fix (GAP 1, GAP 4, GAP 6) ----------
      case "validation_error": {
        const reason = entryResult.reason ?? "Server rejected the operation.";

        // GAP 4: product_delete definitive rejection → restore product from before snapshot
        if (entry.operation_type === "product_delete") {
          try {
            const payload = JSON.parse(entry.payload);
            if (payload.before) {
              restoreProductFromSnapshot(db, payload.before);
            }
          } catch {
            // If payload is unparseable, still mark manual_fix without restore
          }
        }

        // promotion_delete definitive rejection → restore from before snapshot
        if (entry.operation_type === "promotion_delete") {
          try {
            const payload = JSON.parse(entry.payload);
            if (payload.before) {
              restorePromotionFromSnapshot(db, payload.before);
            }
          } catch {
            // best-effort
          }
        }

        // provider_purchase_delete definitive rejection → restore from before snapshot
        if (entry.operation_type === "provider_purchase_delete") {
          try {
            const payload = JSON.parse(entry.payload);
            if (payload.before) {
              restoreProviderPurchaseFromSnapshot(db, payload.before);
            }
          } catch {
            // best-effort
          }
        }

        markOutboxEntry(db, entry.id, {
          status: "manual_fix",
          last_error: reason,
          manual_fix_reason: reason,
          server_result: JSON.stringify(entryResult),
        });
        result.failed += 1;
        blocked = true;
        break;
      }

      // -- product/promotion/provider_purchase LWW conflict resolution ---------
      case "conflict":
        if (
          entry.aggregate_type === "product" ||
          entry.aggregate_type === "promotion" ||
          entry.aggregate_type === "provider_purchase"
        ) {
          const localTs = entry.local_device_timestamp;
          const serverTs = entryResult.server_version ?? null;

          const lwwResult = resolveLww(localTs, serverTs);

          if (lwwResult === null) {
            // Missing or invalid conflict metadata
            markOutboxEntry(db, entry.id, {
              status: "blocked_conflict",
              last_error:
                entryResult.reason ??
                `${entry.aggregate_type} conflict could not be resolved — missing or invalid timestamp metadata.`,
              server_result: JSON.stringify(entryResult),
            });
            result.blocked += 1;
            blocked = true;
          } else if (lwwResult) {
            // Local wins → re-queue as pending with LWW metadata for re-push
            try {
              const existingPayload = JSON.parse(entry.payload);
              const updatedPayload = {
                ...existingPayload,
                lww_resolution: "local_wins",
                local_device_timestamp: localTs,
              };
              db.prepare(`
                UPDATE outbox
                SET status = 'pending',
                    payload = @payload,
                    last_error = @last_error,
                    server_result = @server_result,
                    attempt_count = attempt_count + 1,
                    updated_at = @now
                WHERE id = @id
              `).run({
                id: entry.id,
                payload: JSON.stringify(updatedPayload),
                last_error: entryResult.reason ?? null,
                server_result: JSON.stringify({
                  ...entryResult,
                  lww_resolution: "local_wins",
                }),
                now: new Date().toISOString(),
              });
            } catch {
              markOutboxEntry(db, entry.id, {
                status: "pending",
                last_error: entryResult.reason ?? null,
                server_result: JSON.stringify(entryResult),
              });
            }
            result.failed += 1;
          } else {
            // Server wins → apply server payload locally
            if (entryResult.server_payload) {
              if (entry.aggregate_type === "promotion") {
                applyServerPromotionPayload(db, entryResult.server_payload);
              } else if (entry.aggregate_type === "provider_purchase") {
                applyServerProviderPurchasePayload(db, entryResult.server_payload);
              } else {
                applyServerProductPayload(db, entryResult.server_payload);
              }
            }
            markOutboxEntry(db, entry.id, {
              status: "synced",
              synced_at: new Date().toISOString(),
              server_result: JSON.stringify({
                ...entryResult,
                lww_resolution: "server_wins",
              }),
            });
            result.synced += 1;
          }
        } else {
          // Non-LWW conflict → blocked_conflict
          markOutboxEntry(db, entry.id, {
            status: "blocked_conflict",
            last_error: entryResult.reason ?? "Unresolved conflict on non-LWW entity.",
            server_result: JSON.stringify(entryResult),
          });
          result.blocked += 1;
          blocked = true;
        }
        break;

      case "transient_error":
        markOutboxEntry(db, entry.id, {
          status: "retry_wait",
          last_error: entryResult.reason ?? "Transient server error.",
          server_result: JSON.stringify(entryResult),
        });
        result.failed += 1;
        blocked = true;
        break;

      // -- auth_blocked / blocked → blocked_auth (GAP 5) --------------------
      case "auth_blocked":
      case "blocked":
        markOutboxEntry(db, entry.id, {
          status: "blocked_auth",
          last_error: entryResult.reason ?? "Blocked by server.",
          server_result: JSON.stringify(entryResult),
        });
        result.blocked += 1;
        blocked = true;
        break;

      default:
        markOutboxEntry(db, entry.id, {
          status: "failed",
          last_error: `Unknown server status: ${entryResult.status}`,
          server_result: JSON.stringify(entryResult),
        });
        result.failed += 1;
        blocked = true;
    }
  }

  return result;
}
