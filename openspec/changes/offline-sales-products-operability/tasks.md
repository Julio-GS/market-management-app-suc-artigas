## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 800-1100 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 → PR 2 → PR 3, or keep as one PR only if the approved size exception is intentionally exercised |
| Delivery strategy | single-pr with size exception |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: size-exception
400-line budget risk: High

## Implementation Tasks

- [x] RED: add failing Strict TDD coverage for the schema, offline auth, and connectivity contracts in `src/main/db.test.ts`, `src/main/offline-auth.test.ts`, and `src/main/connectivity-state.test.ts`. Cover additive migration behavior, old outbox rows falling back to `created_at`, `offline_sessions` eligibility, no stale-session cutoff, revalidation flag semantics, and `unknown -> offline -> online -> reconnecting` state transitions. Evidence expected: tests fail before implementation; keep fixtures database-backed and co-located. <!-- sdd-owner: implementation -->

- [x] GREEN: implement the database and state foundations in `src/main/db.ts`, `src/main/offline-auth.ts`, `src/main/connectivity-state.ts`, and `src/main/offline-state.ts`. Add the v4 additive migration, new `outbox` columns/index, offline-session helpers, revalidation helpers, and renderer-facing connectivity state plumbing without breaking existing IPC callers. Evidence expected: targeted tests from the RED step pass, and `pnpm typecheck` stays clean. <!-- sdd-owner: implementation -->

- [x] RED: add failing Sales coverage in `src/main/sales-local.test.ts` and `src/main/sales-ipc.test.ts`. Cover atomic sale persistence, immediate local stock decrement, stock movement audit rows, `sale_create` plus `stock_adjust` outbox rows in one transaction, negative stock warning behavior, fiscal-block rejection, offline-auth rejection mapping, and sales list/status exposure. Evidence expected: tests fail first; include at least one rollback-safety case. <!-- sdd-owner: implementation -->

- [x] GREEN: implement Sales behavior in `src/main/sales-local.ts` and `src/main/sales-ipc.ts`. Enforce offline eligibility, reject `invoiceRequested: true` offline, persist sale/items/payments/stock/outbox atomically, emit local-device timestamps, expose sale listing/status, and preserve manual-fix visibility for definitive rejection paths. Evidence expected: Sales tests turn green and no unrelated IPC signatures regress. <!-- sdd-owner: implementation -->

- [x] RED: add failing Products and sync-recovery coverage in `src/main/products-local.test.ts`, `src/main/products-ipc.test.ts`, `src/main/sync-engine.test.ts`, `src/main/support-ipc.test.ts`, `src/main/pull-reconciliation.test.ts`, and the preload bridge test target under `src/preload/**` if present. Cover create/update/delete/search/barcode offline flows, protected delete rejection, delete snapshot preservation, local-device timestamp recording, LWW conflict handling, `blocked_auth`/`blocked_conflict`/`manual_fix` transitions, retryable vs non-retryable retry rules, and preload exposure of the new methods. Evidence expected: tests fail before code changes. <!-- sdd-owner: implementation -->

- [x] GREEN: implement Products, sync, support, pull, and preload changes in `src/main/products-local.ts`, `src/main/products-ipc.ts`, `src/main/sync-engine.ts`, `src/main/support-ipc.ts`, `src/main/pull-reconciliation.ts`, and `src/preload/index.ts`. Add durable product outbox writes, protected-delete guard, snapshot restore for rejected deletes, LWW resolution using `local_device_timestamp`, sync-state counts, manual retry restrictions, manual-fix preservation, and additive preload IPC contracts. Evidence expected: the RED tests pass and ordered replay remains intact. <!-- sdd-owner: implementation -->

- [x] REFACTOR/TRIANGULATE: run the focused Vitest suites plus `pnpm test` and `pnpm typecheck`, then clean up shared fixtures/helpers in `src/main/**` only where needed to keep the schema, IPC, and sync-state contracts aligned. Preserve behavior, keep tests with the code they validate, and confirm no accidental coupling was introduced. Evidence expected: green test run, green typecheck, and no dropped coverage for the required offline/auth/sync scenarios. <!-- sdd-owner: implementation -->

- [ ] Start or reuse bounded review for the changed paths under `src/main/**` and `src/preload/**` after apply, then validate that no CRITICAL issues remain before handoff. <!-- sdd-owner: parent -->
