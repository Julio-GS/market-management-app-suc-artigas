# Proposal: Offline Sales & Products Operability

**Change:** `offline-sales-products-operability`  
**Status:** proposed  
**Artifact store:** OpenSpec

## Intent

Make the desktop app operational for critical Sales and Products workflows when the device is offline, while preserving local durability, explicit sync state, recoverability, and authorization revalidation before server synchronization.

This proposal focuses on the product and business behavior required for offline operability. It does not prescribe a specific implementation design beyond the existing desktop architecture boundaries: Electron main process, local SQLite persistence, IPC/preload bridge, outbox-based sync, bootstrap data, and renderer-facing state contracts.

## Problem

The project already has strong offline infrastructure: SQLite persistence, transactional outbox entries, sales completion, product CRUD/search, bootstrap ingestion, and sync replay. However, Sales and Products are not yet fully operable as user-facing offline workflows.

Current gaps include:

- Offline connectivity state is not reliable or visible enough for users to understand whether they are working locally or synced.
- Offline auth/session rules are not defined for token expiry, app restart, and reconnect behavior.
- Sales can be completed locally, but users need clear stock behavior, pending sync visibility, manual retry, and recovery when the server rejects an operation.
- Products can be changed locally, but conflict handling rules must be explicit.
- Sync failures, conflicts, and definitive server rejections are not yet a complete user-operable recovery flow.
- Some critical Products and Bootstrap IPC/test coverage is missing, which blocks safe rollout under Strict TDD mode.

## Goals

1. Enable critical Sales and Products workflows to remain usable when the device is offline.
2. Allow offline operation only for users who were already logged in on the device.
3. Keep a locally operational session if the auth token expires while offline.
4. Revalidate authorization before syncing any offline changes after reconnect.
5. Make pending, failed, blocked, and retryable sync states visible to users.
6. Allow users to manually retry failed sync work.
7. Preserve rejected local records for manual fix instead of deleting them silently.
8. Define deterministic product conflict behavior using last-write-wins.
9. Ensure sales decrement local SQLite stock immediately and later sync the stock impact to the server.
10. Provide clear acceptance boundaries for the spec/design phases without implementing backend or renderer details in this proposal.

## Non-goals

- Implementing backend sync, bootstrap, auth, or conflict APIs.
- Enabling offline operation for users who have never logged in on the device.
- Supporting offline fiscal/invoice sales; those remain blocked offline.
- Building a full general-purpose conflict resolution system for every module.
- Covering Promotions, Provider Purchases, Reports, or Support workflows beyond dependencies needed for Sales/Products sync visibility and retry.
- Replacing the existing outbox-based sync model.
- Silently resolving definitive server rejections by deleting local records.
- Guaranteeing correctness when a device clock is wrong; this risk must be surfaced and mitigated where practical.

## Scope

### In scope

- Offline Sales operability:
  - Complete non-fiscal sales while offline.
  - Persist sales and sale items locally.
  - Decrement local SQLite stock immediately for stock-managed products.
  - Enqueue sale and stock-impact sync work durably.
  - Show pending/failed/blocked sync status for sales.
  - Keep definitively rejected offline sales locally marked for manual fix.

- Offline Products operability:
  - Create, update, delete, search, and barcode lookup for products while offline.
  - Enqueue product changes durably.
  - Apply product conflict handling using last-write-wins.
  - Keep definitively rejected product operations locally marked for manual fix.
  - Respect protected/product deletion constraints defined by the domain.

- Offline auth/session behavior:
  - Only previously authenticated users on the same device may operate offline.
  - Expired tokens do not end the local offline session while the device remains offline.
  - Sync is blocked until authorization is revalidated after reconnect.
  - Authorization rejection after reconnect must block sync and preserve local records for fix/retry.

- Sync recovery and user operability:
  - Users can see pending, failed, blocked, and successfully synced state at a level useful for Sales and Products.
  - Users can manually retry retryable sync work.
  - Definitive server rejection requires manual fix state, not silent deletion.
  - Recovery must preserve ordered outbox guarantees where applicable.

- Connectivity and state contracts:
  - The app must distinguish usable offline mode from online/syncing/degraded states.
  - The renderer-facing contract must expose enough state for users to understand sync health and take action.

### Out of scope for the first slice

- Backend endpoint implementation.
- Cross-device merge UX beyond the defined product LWW rule.
- Automatic correction of rejected operations.
- Offline-only first-time onboarding.
- Complex sale lifecycle features such as drafts, cancellations/voids, fiscal invoicing, or promotions unless required by existing sale completion behavior.
- Outbox retention/pruning policy unless needed to support visible recovery states.

## User and business rules

1. **Offline eligibility:** A user may operate offline only if they previously logged in successfully on the device.
2. **No first-time offline login:** A user who has never authenticated on the device cannot use Sales or Products offline.
3. **Token expiry while offline:** If a token expires while the device is offline, the local session remains operational for eligible offline workflows.
4. **Reconnect authorization gate:** On reconnect, authorization must be revalidated before syncing offline work.
5. **Auth rejection:** If revalidation fails, sync must not push local changes. Local records remain available and marked as blocked/manual attention required.
6. **Product conflict rule:** Product conflicts use last-write-wins.
7. **LWW timestamp source:** Last-write-wins uses the local device timestamp for offline product operations.
8. **Clock risk:** Incorrect device clocks can produce incorrect product conflict outcomes. This must be documented and surfaced as a business/operational risk.
9. **Sales stock rule:** Completing an offline sale immediately decrements local SQLite stock for stock-managed products.
10. **Stock sync rule:** The local stock impact from an offline sale is later synced to the server through the sync flow.
11. **Sync visibility:** Users must be able to see when Sales/Product changes are pending, failed, blocked, or require manual fix.
12. **Manual retry:** Users must be able to manually retry retryable sync failures.
13. **Definitive rejection:** If the server definitively rejects an offline sale or product operation, the local record must be kept and marked for manual fix. It must not be silently deleted.
14. **Fiscal sales:** Offline fiscal/invoice sales remain blocked.

## First product slice

The first slice should make offline behavior safe and explainable for the most critical Sales and Products workflows:

1. Offline session eligibility and reconnect revalidation rules.
2. Offline sale completion with immediate local stock decrement and durable sync queueing.
3. Product create/update/delete/search/barcode lookup with durable sync queueing.
4. Product conflict behavior documented as last-write-wins using local device timestamps.
5. User-visible sync state for pending, failed, blocked, and manual-fix records.
6. Manual retry for retryable sync failures.
7. Preservation of definitively rejected records for manual fix.
8. Required test coverage for critical Sales/Products/offline/session/sync state behavior under Strict TDD mode.

## Acceptance boundaries

The change is acceptable when the spec/design can prove these outcomes:

- An eligible previously logged-in user can operate supported Sales and Products workflows while offline.
- A never-logged-in user cannot operate offline.
- An expired token while offline does not terminate local offline operation, but sync remains gated by revalidation on reconnect.
- Revalidation failure prevents sync and clearly marks affected work as blocked/manual attention required.
- Offline sale completion persists locally, decrements local stock immediately, and creates durable sync work.
- Product operations persist locally and create durable sync work.
- Product conflicts resolve with last-write-wins based on local device timestamps, with clock-skew risk documented.
- Users can identify pending, failed, blocked, and manual-fix sync records.
- Users can manually retry retryable sync failures.
- Definitively rejected sale/product operations remain locally visible and are marked for manual fix.
- Fiscal/invoice sales remain blocked offline.
- The proposal remains compatible with the existing SQLite + transactional outbox + IPC architecture.

## Affected areas

- Sales local workflow and IPC contract.
- Products local workflow and IPC contract.
- Offline session/auth state and cached user eligibility.
- Connectivity/offline state reporting.
- Sync engine status, retry, rejection, and conflict state contracts.
- SQLite schema/data state where needed for manual-fix/rejection/conflict metadata.
- Preload/renderer-facing bridge contracts for sync state and retry actions.
- Test coverage for Products IPC, Products CRUD, Sales offline behavior, auth/session edge cases, sync recovery, and state visibility.

## Dependencies and assumptions

- Existing backend sync, pull, bootstrap, and auth revalidation endpoints are assumed to exist or remain externally owned.
- The desktop app remains the local source of truth while offline, with server reconciliation after reconnect.
- The existing outbox pattern remains the durability mechanism for offline writes.
- Renderer implementation may live outside this repository; this change must at minimum expose clear desktop contracts for sync visibility and manual retry.
- Strict TDD mode is active for implementation phases.
- Existing fiscal/invoice blocking behavior remains unchanged.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Incorrect device clocks affect product LWW outcomes | Product updates may resolve in the wrong direction | Document the risk, expose timestamps where useful, and consider future server-time or clock-skew mitigation |
| Offline auth is too permissive | Unauthorized local operation or attempted sync | Require prior login on device and revalidate before sync |
| Revalidation failure after offline work | Users may be unable to sync completed work | Preserve records, mark blocked/manual fix, and provide clear retry/recovery path |
| Server rejects local sale/product operation | Data may diverge if hidden or deleted | Keep local record marked for manual fix; never delete silently |
| Local stock diverges from server stock | Stock may be temporarily inaccurate | Decrement locally immediately, sync stock impact, and surface failed/blocked sync |
| Renderer does not surface sync state | Users cannot trust offline mode | Define explicit state and retry contracts during spec/design |
| Product LWW overbuilds conflict handling | More complexity than needed for first slice | Keep first slice deterministic: LWW only, manual fix for definitive rejection |
| Existing native DB/test environment mismatch | Tests may fail for environment reasons | Follow project rebuild guidance before implementation/verification |

## Rollback

If the change causes unsafe behavior during rollout:

- Keep or restore the offline feature gate to disable offline Sales/Products operation.
- Preserve existing local data and outbox records; do not delete pending or rejected records during rollback.
- Disable sync push for affected offline operation types if authorization/conflict handling is unsafe.
- Continue allowing read-only inspection/export of local records where possible for support recovery.
- Revert renderer exposure of new offline actions while keeping diagnostic state visible if safe.

## Success criteria

- Sales and Products can be used offline by eligible users with clear local persistence guarantees.
- Users understand when work is local, pending sync, failed, blocked, or requires manual fix.
- Manual retry is available for retryable sync failures.
- Offline token expiry does not disrupt local operation, but reconnect sync is authorization-gated.
- Product conflicts have a documented deterministic rule: local-device-timestamp last-write-wins.
- Server rejections never silently delete local offline work.
- Critical acceptance behavior is covered by tests before implementation is considered complete.

## Proposal question round for user review

The parent orchestrator already captured the core product decisions used in this proposal. Before spec/design, the remaining product assumptions worth confirming are:

1. What level of detail should users see for manual-fix records: only a summary count/status, or per-record rejection reason and attempted operation details?
2. Should offline operation have any maximum allowed stale-session age, or is “previously logged in on this device” sufficient until reconnect revalidation?
3. For product last-write-wins, should users be warned when the device clock appears suspicious, or is documenting the operational risk enough for the first slice?
4. Should manual retry be available per individual record, for all failed records, or both?
5. Is sales history/listing required in the first slice, or is sale completion plus sync-state visibility sufficient?
