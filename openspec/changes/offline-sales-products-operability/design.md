# Design: Offline Sales & Products Operability

This design implements the accepted Sales, Products, Offline Auth, and Sync State specs inside the existing Electron main process + SQLite + IPC/preload + outbox/sync architecture. The core decision is to keep the desktop main process as the offline boundary: renderer code asks for state and actions through IPC, while all durability, auth eligibility, outbox ordering, retry, and conflict rules are enforced next to SQLite.

## Decision Summary

| Area | Decision |
| --- | --- |
| Offline boundary | Electron main owns offline eligibility, local writes, sync state, and retry decisions. The renderer only uses preload IPC contracts. |
| Durability | Sales, stock impacts, and product mutations write SQLite records and outbox entries in the same transaction. |
| Auth | Offline Sales/Products mutations require a cached `offline_sessions` user. No maximum stale-session age is enforced. Sync revalidates authorization before push after offline work. |
| Connectivity | Add a main-process connectivity service that feeds `offline:get-state` and optional state-change notifications. Initial state remains `unknown`. |
| Product conflicts | Product conflicts use LWW with the outbox `local_device_timestamp`. Missing conflict metadata blocks as `blocked_conflict`; definitive rejection becomes `manual_fix`. |
| Manual retry | Retry is allowed only for retryable statuses (`failed`, `retry_wait`). Retried entries return to `pending` and replay still respects creation order. |
| Manual fix | Definitive server rejection is represented by outbox status `manual_fix`. Local records are preserved and exposed with rejection details; entries are not auto-retried or deleted. |
| Stock sync | A sale creates one `sale_create` outbox entry plus one `stock_adjust` entry per stock movement, ordered in the same transaction. |
| Rollout | Keep the existing `offline.enabled` gate for rollout. The DB initializes as today; offline actions can be disabled at the IPC edge if the gate is false. |

## Existing Architecture Fit

The implementation stays in the current desktop repository shape:

```text
Renderer (Next.js, external repo)
  -> preload/index.ts bridge
  -> src/main/*-ipc.ts handlers
  -> src/main/*-local.ts services
  -> SQLite + outbox
  -> sync-engine.ts + pull-reconciliation.ts
```

No backend or renderer implementation is part of this design. The desktop contract must be explicit enough for the renderer to show offline readiness, pending work, failed work, auth blocks, and manual-fix records.

## Implementation Boundaries

| Boundary | Owns | Planned files |
| --- | --- | --- |
| Database/migrations | Durable schema and backwards-compatible migration defaults | `src/main/db.ts`, `src/main/db.test.ts` |
| Offline auth guard | Cached-session eligibility and sync revalidation flag behavior | new `src/main/offline-auth.ts`, tests |
| Connectivity state | Online/offline/reconnecting/unknown state source | new `src/main/connectivity-state.ts`, `offline-state.ts`, tests |
| Sales local service | Atomic sale, stock movements, sale + stock outbox entries, sale listing | `sales-local.ts`, `sales-ipc.ts`, tests |
| Products local service | Protected delete guard, product outbox timestamp, delete restore payload | `products-local.ts`, `products-ipc.ts`, tests |
| Sync engine | Status state machine, LWW conflict handling, manual-fix transitions | `sync-engine.ts`, `support-ipc.ts`, tests |
| Pull reconciliation | Server-wins product application and stock reconciliation | `pull-reconciliation.ts`, tests |
| Preload bridge | Renderer-facing typed contracts | `src/preload/index.ts`, IPC tests |

## Data Model Changes

Add a new migration after v3. It must be additive and non-destructive.

| Table | Change | Reason | Backward compatibility |
| --- | --- | --- | --- |
| `outbox` | `local_device_timestamp TEXT` | Timestamp used for product LWW and operational display. | Existing rows fall back to `created_at`. |
| `outbox` | `manual_fix_reason TEXT` | Stable user/support-facing rejection reason. | Existing rows remain `NULL`. |
| `outbox` | `entity_label TEXT` | Lightweight label for sync-state UI without reparsing every payload. | Existing rows can compute labels from payload/aggregate id. |
| `outbox` | index on `(status, created_at)` | Fast state lists and ordered retry. | Safe additive index. |

No domain table needs destructive changes. Existing `sales`, `sale_items`, `sale_payments`, `stock_movements`, `products`, `stock_balances`, and `offline_sessions` remain valid.

### Outbox Status Contract

| Status | Meaning | Retryable? |
| --- | --- | --- |
| `pending` | Waiting to sync. | No manual action needed. |
| `in_flight` | Selected for current push attempt. | No. |
| `synced` | Accepted, duplicate, or resolved successfully. | No. |
| `failed` | Retryable failure after server/network handling. | Yes. |
| `retry_wait` | Transient/network failure; waiting for retry/manual retry. | Yes. |
| `blocked_auth` | Authorization revalidation failed before push. | Not until auth succeeds. |
| `blocked_conflict` | Conflict could not be resolved automatically due to missing/invalid metadata. | Not directly. |
| `manual_fix` | Definitive non-retryable rejection; local record needs user/support action. | No. |

## Offline Auth Design

### Decisions

1. A cached row in `offline_sessions` is the eligibility proof.
2. There is no local max-age cutoff for offline operation.
3. Sales/Product mutating IPC handlers run an eligibility guard before writing.
4. Successful offline writes mark `revalidation_required = '1'` so the next push revalidates before sending any outbox entry.
5. Revalidation failure marks sync-eligible entries as `blocked_auth` and preserves all local records.
6. Revalidation success clears `revalidation_required` and moves prior `blocked_auth` entries back to `pending` before ordered replay.

### Service Contract

Add `offline-auth.ts` with pure database helpers:

| Function | Behavior |
| --- | --- |
| `getOfflineSession(db)` | Returns the cached session, or `null`. |
| `assertOfflineEligible(db)` | Throws/returns a typed failure when no cached session exists. |
| `getActorUserId(db)` | Returns cached `user_id` for outbox `actor_user_id`. |
| `markOfflineWorkRequiresRevalidation(db)` | Sets metadata `revalidation_required = '1'`. |
| `unblockAuthEntriesAfterRevalidation(db)` | Moves `blocked_auth` rows to `pending` after successful revalidation. |

IPC handlers translate the eligibility failure to a stable renderer error code, for example `OFFLINE_AUTH_REQUIRED`.

## Connectivity and Offline State

### Decision

Introduce a main-process connectivity state provider. `getOfflineState(db)` should accept or merge an externally supplied connectivity state instead of hardcoding `unknown`.

### State Flow

```text
app startup
  -> connectivity = unknown
  -> detector completes
  -> connectivity = online | offline
  -> offline:get-state returns current value
  -> optional offline:state-changed event notifies renderer
```

### Renderer-Facing State

Keep existing fields and add details without removing fields:

| Contract | Required shape |
| --- | --- |
| `OfflineState.connectivity` | `"unknown" | "online" | "offline" | "reconnecting"` |
| `OfflineState.ready` | `bootstrap === "complete" && !degraded` |
| `OfflineState.statusCounts` | Optional/additive counts by outbox status for richer UI. |
| `sync:get-state` | Aggregate counts for `pending`, `failed`, `retry_wait`, `blocked_auth`, `blocked_conflict`, `manual_fix`, plus `revalidationRequired` and `lastSyncAt`. |
| `support:listOutbox` | Per-entry details for Sales/Product sync status, including local timestamp, error, payload, and server result. |

Polling `offline.getState()` is sufficient for correctness. A preload `offline.onStateChanged(callback)` event can be added for responsiveness, but it must not be the only way to observe state.

## Sales Design

### Sale Completion Flow

```text
sales.complete(input)
  -> validate IPC payload
  -> assert cached offline session
  -> reject invoiceRequested=true
  -> transaction:
       insert sales row
       insert sale_items rows
       insert sale_payments rows
       decrement stock_balances for maneja_stock products
       insert stock_movements rows
       insert sale_create outbox row
       insert stock_adjust outbox row per stock movement
       mark revalidation_required
  -> return sale + warnings
```

### Stock Impact Contract

For each stock-managed item, create a `stock_adjust` outbox entry after the `sale_create` entry.

| Field | Value |
| --- | --- |
| `operation_type` | `stock_adjust` |
| `aggregate_type` | `stock` |
| `aggregate_id` | Product id |
| `payload.sale_id` | Local sale id |
| `payload.stock_movement_id` | Local movement id |
| `payload.product_id` | Product id |
| `payload.quantity` | Negative sold quantity |
| `payload.reason` | `sale` |
| `payload.local_balance_after` | Local `stock_balances.stock_actual` after decrement |
| `local_device_timestamp` | Same ISO timestamp used by the local transaction |

This preserves the existing immediate local stock rule while making the stock impact visible and retryable independently during sync.

### Sale Visibility

Add minimal sale listing support because rejected sales must remain discoverable:

| IPC/preload method | Purpose |
| --- | --- |
| `sales.get(saleId)` | Existing detail lookup; enrich with sync status where possible. |
| `sales.list(filters)` | New local listing by date range/status/pagination, sorted by `created_at DESC`. |
| `support.listOutbox({ aggregateType: "sale" })` | Detailed sync/manual-fix inspection. |

A definitive sale rejection sets the sale outbox entry to `manual_fix`; sale rows, items, payments, and stock movements remain intact.

## Products Design

### Product Mutation Flow

```text
products.create/update/delete(input)
  -> validate IPC payload
  -> assert cached offline session
  -> transaction:
       apply product change locally
       insert product outbox row with local_device_timestamp
       include actor_user_id and entity_label
       mark revalidation_required
  -> return local product result
```

### Protected Delete

Before deleting, read `is_protected`:

- `is_protected = 1` -> reject with a stable error and do not write an outbox entry.
- `is_protected = 0` -> proceed.

### Delete Rejection Preservation

The spec requires local delete behavior and rejection preservation. To satisfy both:

1. Offline delete removes the product from `products` as specified.
2. The `product_delete` outbox payload stores a `before` snapshot of the product.
3. If the server definitively rejects the delete, sync restores the snapshot and marks the outbox row `manual_fix`.
4. The restored product is visible locally with the manual-fix entry discoverable through sync state.

### Product LWW Conflict Flow

Each product outbox row records `local_device_timestamp`. On a product conflict result during push:

```text
if local_device_timestamp > server_updated_at:
  local wins
  push the same product operation with LWW resolution metadata
  mark synced when accepted
else:
  server wins
  apply server product payload locally
  mark original outbox row synced with server-won result
```

If required conflict metadata is missing, the entry becomes `blocked_conflict` instead of guessing. This protects data integrity and surfaces the device-clock risk.

### Product Payload Requirements

| Operation | Payload additions |
| --- | --- |
| `product_create` | Full product fields, `local_device_timestamp`. |
| `product_update` | Changed fields, `local_device_timestamp`. |
| `product_delete` | `local_device_timestamp`, `before` snapshot for restore on rejection/server-wins. |

## Sync Engine Design

### Push State Machine

```text
pending
  -> in_flight
  -> synced                 accepted / duplicate / LWW resolved
  -> retry_wait             network or transient failure
  -> failed                 retryable server failure
  -> manual_fix             definitive validation/rejection
  -> blocked_conflict       unresolved conflict metadata

pending/retry_wait/failed
  -> pending                manual retry for retryable entries only

pending
  -> blocked_auth           revalidation failure before any push
blocked_auth
  -> pending                successful revalidation
```

### Ordered Replay Rules

1. Replay selects `pending` entries ordered by `created_at ASC, rowid ASC`.
2. Entries are marked `in_flight` before push.
3. On the first blocking failure (`manual_fix`, `blocked_conflict`, non-retryable rejection), later entries are reset to `pending` and are not pushed further in that cycle.
4. Manual retry does not jump the queue; it only changes status to `pending`.
5. Pull reconciliation should run only after push is not blocked by auth/conflict/manual-fix failure.

### Server Result Mapping

| Server status | Desktop action |
| --- | --- |
| `accepted`, `duplicate` | Mark `synced`; store `server_result`; set `synced_at`. |
| `transient_error` | Mark `retry_wait`; preserve error and result. |
| retryable validation/temporary failure | Mark `failed`; user may retry. |
| definitive validation/rejection | Mark `manual_fix`; preserve local record. |
| `auth_blocked` or failed revalidation | Mark/preserve as `blocked_auth`; do not push entries. |
| product `conflict` | Apply LWW flow. |
| unresolved non-product conflict | Mark `blocked_conflict` unless classified as definitive rejection. |

## Manual Retry and Manual Fix

### Manual Retry

Extend `support:retry` so it accepts only retryable states:

| Current status | Retry result |
| --- | --- |
| `failed` | Set `pending`, clear retry metadata. |
| `retry_wait` | Set `pending`, clear retry metadata. |
| `blocked_auth` | Reject until auth revalidation succeeds. |
| `blocked_conflict` | Reject; requires conflict/manual resolution. |
| `manual_fix` | Reject; requires corrective action, not retry. |
| `synced` | Reject. |

### Manual Fix

Manual-fix entries must expose enough information for the user/support flow:

- outbox id
- entity type and id
- operation type
- display label
- local device timestamp
- rejection reason
- payload attempted
- server result
- associated local record availability

No automatic delete, overwrite, or retry is allowed for `manual_fix` entries.

## IPC and Preload Contract Changes

| Area | Add/change |
| --- | --- |
| `offline:get-state` | Return current connectivity instead of hardcoded `unknown`; keep degraded fallback. |
| `offline:on-state-changed` | Optional event subscription for renderer responsiveness. |
| `sync:get-state` | Add counts by status and `manualFixCount`; keep existing fields. |
| `outbox:list` | Support filters by `status`, `aggregateType`, `operationType`; return enriched outbox fields. |
| `outbox:retry` | Restrict to `failed` and `retry_wait`. |
| `sales:list` | Add local sales history/status lookup. |
| `sales:complete` | Add `OFFLINE_AUTH_REQUIRED` error mapping. |
| `products:*` | Add `OFFLINE_AUTH_REQUIRED`, protected delete error, and LWW timestamp-backed outbox behavior. |

All preload additions should be additive so existing renderer calls continue to work.

## Pull Reconciliation Impact

Pull remains server-authoritative for inbound records, but product LWW adds one nuance:

- Server-wins product conflict results should reuse the same product apply helper used by pull reconciliation.
- Stock pull changes still update `stock_balances` as server-authoritative reconciliation.
- Local stock decrements from sales remain visible immediately; later stock pull may reconcile the final server value.

## Testing Strategy — Strict TDD

Strict TDD is active. Implementation must write failing tests first, using existing Vitest + temp SQLite fixture patterns.

### Required Test Groups

| File/test area | Required coverage |
| --- | --- |
| `db.test.ts` | v4 migration applies to old DB, is idempotent, preserves old outbox rows, fallback timestamp behavior. |
| `offline-auth.test.ts` | cached-session eligibility, never-logged-in rejection, no stale-age cutoff, actor user id, revalidation flag. |
| `connectivity-state.test.ts` | `unknown -> offline -> online`, reconnecting/degraded state, `offline:get-state` integration. |
| `sales-local.test.ts` | sale + stock movement + sale outbox + stock outbox in one transaction; negative stock warning; rollback safety. |
| `sales-ipc.test.ts` | auth-required error, fiscal block unchanged, `sales:list` status mapping. |
| `products-local.test.ts` | create/update/delete outbox timestamp, protected delete guard, delete payload snapshot, rollback safety. |
| `products-ipc.test.ts` | all product IPC channels, validation errors, protected delete, auth-required error. |
| `sync-engine.test.ts` | revalidation gate, auth block preservation, unblock after success, manual-fix transition, ordered blocking, retryable transitions. |
| `support-ipc.test.ts` | retry allowed for `failed`/`retry_wait`, rejected for `manual_fix`/`blocked_auth`/`synced`, list filters. |
| `pull-reconciliation.test.ts` | server-wins product apply and stock reconciliation do not skip cursor safety. |
| `preload`/IPC bridge tests | new methods are exposed without breaking existing bridge shape. |

### Environment Note

`better-sqlite3` may need rebuild for the active Node/Electron runtime before tests can pass. This is an environment prerequisite, not a design exception.

## Migration and Backward Compatibility Checklist

- [ ] Migration is additive only; no existing table is dropped or rewritten.
- [ ] Existing outbox rows without `local_device_timestamp` use `created_at` as fallback.
- [ ] Existing `failed`, `retry_wait`, and `blocked_*` statuses remain readable.
- [ ] New `manual_fix` status works because `outbox.status` is unconstrained text.
- [ ] Existing preload calls keep their current names and result fields.
- [ ] Existing offline feature gate remains available for rollback.
- [ ] Product delete rejection can restore from the outbox `before` snapshot.
- [ ] Sync replay never advances past a blocking entry.

## Risks and Mitigations

| Risk | Mitigation |
| --- | --- |
| Device clock skew causes wrong product LWW winner | Surface `local_device_timestamp` in outbox details and document operational risk. Block conflicts when metadata is missing. |
| Manual-fix state becomes a dead end | Preserve payload/server result and expose export/list support data; product corrections can be made through normal product operations. |
| Stock diverges temporarily | Decrement locally for operability, queue stock impacts, then reconcile from server stock pull. |
| Auth rejection strands local work | Preserve records, mark `blocked_auth`, and allow sync only after successful revalidation. |
| Renderer misses state changes | Keep polling contracts authoritative; event subscription is additive only. |
| Large first slice | Use Strict TDD and keep backend/renderer implementations out of scope; desktop contracts are the deliverable here. |

## Definition of Done for Apply/Verify

- [ ] Eligible cached users can complete non-fiscal sales and product CRUD offline through IPC.
- [ ] Never-logged-in users are rejected for offline Sales/Product mutations.
- [ ] Token expiry while offline does not block local writes; reconnect push is revalidation-gated.
- [ ] Sales decrement local stock immediately and queue sale + stock impact outbox entries atomically.
- [ ] Products record `local_device_timestamp` and resolve conflicts by LWW.
- [ ] Pending, failed, blocked, synced, retryable, and manual-fix states are visible through IPC/preload contracts.
- [ ] Manual retry works only for retryable failures and preserves ordered replay.
- [ ] Definitive rejections preserve local records and transition to `manual_fix`.
- [ ] All required behavior is covered by Strict TDD tests before implementation is complete.
