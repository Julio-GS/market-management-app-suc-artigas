# Exploration: Offline Sales & Products Operability

**Change:** `offline-sales-products-operability`
**Date:** 2026-07-20
**Status:** complete

## Executive Summary

The codebase already has a well-architected offline foundation: local SQLite persistence via better-sqlite3, transactional outbox pattern for sync, ordered replay engine with auth revalidation, pull-based reconciliation with cursor safety, bootstrap snapshot ingestion, and IPC handlers bridging the Electron main process to the sandboxed renderer. The Sales and Products modules have core CRUD operations that write locally and enqueue outbox entries atomically.

However, the system is **not yet fully offline-operable** as a standalone POS/product-management experience. Key gaps: no connectivity detection, no product IPC tests, no offline-first auth flow, no conflict resolution surface, no sales listing/history, no retry mechanism exposed to the user, and the offline feature flag defaults to `false`.

---

## 1. Architecture Overview

### 1.1 Process Model

```
┌─────────────────────────────────────────┐
│  Electron Main Process (Node.js)        │
│  ┌───────────────────────────────────┐  │
│  │  IPC Handlers (ipcMain.handle)    │  │
│  │  ┌─────────┐ ┌─────────┐         │  │
│  │  │ sales   │ │products │  ...    │  │
│  │  │ -ipc.ts │ │-ipc.ts  │         │  │
│  │  └────┬────┘ └────┬────┘         │  │
│  │       │           │               │  │
│  │  ┌────▼───────────▼────┐          │  │
│  │  │  Local modules      │          │  │
│  │  │  (sales-local.ts,   │          │  │
│  │  │   products-local.ts)│          │  │
│  │  └─────────┬───────────┘          │  │
│  │            │                       │  │
│  │  ┌─────────▼───────────┐          │  │
│  │  │  SQLite (better-    │          │  │
│  │  │  sqlite3, WAL mode) │          │  │
│  │  │  ┌────────┐┌──────┐ │          │  │
│  │  │  │ outbox ││ data │ │          │  │
│  │  │  └────────┘└──────┘ │          │  │
│  │  └─────────────────────┘          │  │
│  └───────────────────────────────────┘  │
│              │ contextBridge            │
│  ┌───────────▼───────────────────────┐  │
│  │  Preload (preload/index.ts)       │  │
│  │  Exposes marketDesktop bridge     │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
┌─────────────────────────────────────────┐
│  Renderer (Next.js, sandboxed)          │
│  Uses window.marketDesktop.* via IPC    │
└─────────────────────────────────────────┘
```

### 1.2 Database Schema (relevant tables)

| Table | Purpose | Migration |
|-------|---------|-----------|
| `products` | Product catalog with stock tracking flag | v2 |
| `stock_balances` | Current stock per product (upserted) | v2 |
| `sales` | Completed sales (local-first) | v3 |
| `sale_items` | Line items per sale | v3 |
| `sale_payments` | Payment methods per sale | v3 |
| `stock_movements` | Audit trail of stock changes | v3 |
| `outbox` | Durable queue for server sync | v3 |
| `metadata` | Key-value app state (bootstrap_status, sync_cursor, degraded, etc.) | v1 |
| `offline_sessions` | Cached user profile from bootstrap | v2 |

### 1.3 IPC Channel Map

| Module | Channel | Direction | Handler |
|--------|---------|-----------|---------|
| **Sales** | `offline:sales:complete` | renderer→main | `completeOfflineSale` |
| **Sales** | `offline:sales:get` | renderer→main | Sale lookup by ID |
| **Products** | `offline:products:create` | renderer→main | `createOfflineProduct` |
| **Products** | `offline:products:update` | renderer→main | `updateOfflineProduct` |
| **Products** | `offline:products:delete` | renderer→main | `deleteOfflineProduct` |
| **Products** | `offline:products:list` | renderer→main | `searchOfflineProducts` |
| **Products** | `offline:products:get` | renderer→main | `getOfflineProduct` |
| **Products** | `offline:products:findByCode` | renderer→main | Barcode lookup |
| **Offline** | `offline:get-state` | renderer→main | `getOfflineState` |
| **Bootstrap** | `offline:bootstrap:status` | renderer→main | `getBootstrapStatus` |
| **Bootstrap** | `offline:bootstrap:start` | renderer→main | Full snapshot pull |
| **Bootstrap** | `offline:bootstrap:resume` | renderer→main | Restart/continue |
| **Sync** | `sync:start` | renderer→main | Push + Pull |
| **Sync** | `sync:pull` | renderer→main | Pull only |
| **Sync** | `sync:get-state` | renderer→main | Pending/failed counts |

---

## 2. Sales Module — Current State

### 2.1 What Already Works

**`sales-local.ts` — `completeOfflineSale(db, input)`**

- ✅ Single-transaction sale: inserts `sales` row, `sale_items`, `sale_payments`
- ✅ Stock deduction for `maneja_stock` products via `stock_balances` upsert
- ✅ `stock_movements` audit trail recorded
- ✅ Negative stock allowed with warning (reconciled on sync)
- ✅ Outbox entry (`sale_create`, aggregate `sale`) with idempotency key
- ✅ `FiscalBlockedError` thrown when `invoiceRequested === true`
- ✅ Installation ID prefix on idempotency key: `{installationId}:{outboxId}`
- ✅ `OfflineSaleResult` shape includes sale, stockMovements, warnings, outboxId

**`sales-ipc.ts`**

- ✅ `validateSaleInput()` — lightweight runtime payload validation (items, payments, total, invoiceRequested)
- ✅ `COMPLETE_SALE` handler with error discrimination (FISCAL_BLOCKED, INVALID_INPUT, SALE_ERROR)
- ✅ `GET_SALE` handler returns sale with items and payments
- ✅ Proper handler registration/unregistration

### 2.2 Test Coverage

| File | Tests | Status |
|------|-------|--------|
| `sales-local.test.ts` | 15 tests | ✅ Present |
| `sales-ipc.test.ts` | Present | ✅ Present |

**`sales-local.test.ts` covers:**
- Non-fiscal sale persistence (sale, items, payments, outbox)
- Restart durability (close/reopen)
- Stock deduction and movement recording
- Negative stock warning
- Fiscal blocking (throws, no orphan records, message)
- Outbox durability (pending status, idempotency key, payload)

### 2.3 Gaps

| Gap | Severity | Detail |
|-----|----------|--------|
| **No sales listing** | HIGH | Only `get` by ID exists. No `list` with date range, pagination, or status filter. Offline POS needs to show recent sales history. |
| **No sale cancellation/void** | MEDIUM | Sales cannot be voided or cancelled offline. Would need an outbox entry for `sale_void`. |
| **No draft sales** | LOW | The design is "complete-only" — no create-draft-then-finalize flow. May be intentional for POS simplicity. |
| **No discount/promotion application** | MEDIUM | `sale_items` has `applied_promotion_id` and `applied_promotion_type` columns but `completeOfflineSale` doesn't populate them. |
| **Customer is hardcoded** | LOW | `customer` defaults to `"Mostrador"`. No customer field in `OfflineSaleInput`. |

---

## 3. Products Module — Current State

### 3.1 What Already Works

**`products-local.ts`**

- ✅ `createOfflineProduct` — transactional insert + outbox (`product_create`)
- ✅ `updateOfflineProduct` — COALESCE-based partial update + outbox (`product_update`)
- ✅ `deleteOfflineProduct` — transactional delete + outbox (`product_delete`)
- ✅ `listOfflineProducts` — ordered by detalle ASC
- ✅ `searchOfflineProducts` — case-insensitive LIKE on detalle and codigos
- ✅ `findOfflineProductByCode` — barcode lookup via JSON array LIKE
- ✅ `getOfflineProduct` — single product by ID
- ✅ All operations return `OfflineProductResult` with consistent shape
- ✅ `mapRow()` normalizes SQLite columns to camelCase JS shape

**`products-ipc.ts`**

- ✅ `validateProductInput()` — lightweight schema guard
- ✅ 6 IPC channels: CREATE, UPDATE, DELETE, LIST, GET, FIND_BY_CODE
- ✅ LIST channel delegates to `searchOfflineProducts` (supports optional search filter)
- ✅ All handlers wrapped in try/catch with error message extraction

### 3.2 Test Coverage

| File | Tests | Status |
|------|-------|--------|
| `products-local.test.ts` | 12 tests | ✅ Present |
| `products-ipc.test.ts` | — | ❌ **MISSING** |

**`products-local.test.ts` covers:**
- `searchOfflineProducts` without filters (all, order)
- `searchOfflineProducts` with search filter (case-insensitive, partial, barcode, no-match, multi-match)
- Result shape mapping (all fields)
- `findOfflineProductByCode` (exact match, second barcode, no-match, full shape)

**Missing from tests:**
- `createOfflineProduct` — no test for the create operation
- `updateOfflineProduct` — no test for the update operation
- `deleteOfflineProduct` — no test for the delete operation
- Transaction rollback behavior on failure
- `is_protected` guard (protected products should not be deletable)
- Outbox creation verification for create/update/delete operations

### 3.3 Gaps

| Gap | Severity | Detail |
|-----|----------|--------|
| **No IPC tests** | **CRITICAL** | `products-ipc.test.ts` does not exist. All 6 IPC handlers are untested. |
| **No stock balance management** | HIGH | Stock is modified via sale operations and pull reconciliation, but there's no direct `offline:products:adjustStock` or similar IPC handler. Products with `maneja_stock=1` have no way to independently adjust stock offline. |
| **No `is_protected` enforcement** | MEDIUM | `deleteOfflineProduct` does not check `is_protected`. Protected products from the server can be deleted locally. |
| **No product create/update/delete tests** | HIGH | `products-local.test.ts` only tests `searchOfflineProducts` and `findOfflineProductByCode`. The CRUD operations have zero test coverage. |
| **No batch operations** | LOW | No bulk product import/update support. |
| **`validateProductInput` is minimal** | MEDIUM | Only checks `detalle` is non-empty. No validation for `costo_neto`, `costo_final` numeric format, `codigos` array shape, etc. |

---

## 4. Offline Infrastructure — Current State

### 4.1 What Already Works

| Component | File | Status |
|-----------|------|--------|
| Database lifecycle | `db.ts` | ✅ WAL mode, busy timeout, FK enforcement, migrations v1-v3 |
| Config with offline feature gate | `config.ts` | ✅ `offline.enabled` defaults to `false`; `integrityCheckOnStartup` defaults to `true` |
| Offline state query | `offline-state.ts` | ✅ Degraded flag, bootstrap status, outbox counts, lastSyncAt |
| Offline IPC | `offline-ipc.ts` | ✅ Graceful degradation when DB unavailable |
| Bootstrap engine | `bootstrap.ts` | ✅ Snapshot ingestion, resume/start, idempotent INSERT OR REPLACE |
| Bootstrap IPC | `bootstrap-ipc.ts` | ✅ Status, start, resume channels |
| Sync engine (outbox replay) | `sync-engine.ts` | ✅ Ordered push, auth revalidation gate, per-entry status handling, blocking on failure |
| Pull reconciliation | `pull-reconciliation.ts` | ✅ Cursor safety invariant, apply for product/promotion/provider_purchase/stock |
| Sync IPC | `sync-ipc.ts` | ✅ `sync:start` (push+pull), `sync:pull`, `sync:get-state` with backend fetch factories |

**Outbox status lifecycle:**
```
pending → in_flight → synced
                    → failed
                    → retry_wait
                    → blocked_auth
                    → blocked_conflict
```

**Key invariants enforced:**
1. Outbox entries are created in the same transaction as the business write (atomic durability).
2. Sync cursor only advances when every change in a batch is consumed (no skipped records).
3. Auth revalidation gates the entire push — no entries are sent until revalidation passes.
4. On first permanent failure, all subsequent entries stay `pending` (ordered delivery guarantee).
5. `in_flight` transition before push prevents duplicate sends.

### 4.2 Test Coverage

| File | Tests | Status |
|------|-------|--------|
| `offline-state.test.ts` | 12 tests | ✅ Shape contract + DB + IPC handler |
| `sync-engine.test.ts` | 10 tests | ✅ markOutboxEntry, replayOutbox, revalidation, counts, skip |
| `pull-reconciliation.test.ts` | Present | ✅ Cursor safety (mock-based) |
| `bootstrap.test.ts` | Present | ✅ Bootstrap + ingest |
| `sync-ipc.test.ts` | Present | ✅ Handler registration + push fn factory |
| `db.test.ts` | Present | ✅ Path, open, WAL, busy timeout, migrations, idempotent |
| `bootstrap-ipc.test.ts` | — | ❌ **MISSING** |

### 4.3 Gaps

| Gap | Severity | Detail |
|-----|----------|--------|
| **No connectivity detection** | **CRITICAL** | `connectivity` in OfflineState is always `"unknown"`. There is no `navigator.onLine` integration, no `net` module ping, no online/offline event listener. The renderer cannot react to network state changes. |
| **No automatic retry** | HIGH | The outbox has `retry_wait` status but no automatic retry loop. The sync engine relies on the renderer to call `sync:start`. No exponential backoff, no max retry cap. |
| **No conflict resolution surface** | HIGH | When server returns `conflict` or `validation_error`, the entry is marked `failed` and processing stops. There is no UI to inspect, resolve, or force-push conflicted entries. The `support` IPC surface exists (list/retry/export outbox) but there's no user-facing resolution flow. |
| **Offline feature gated** | MEDIUM | `offline.enabled` defaults to `false`. The exploration scope says "ensure fully offline operability" — this gate must be addressed in the proposal. Should it remain gated? What's the rollout plan? |
| **No offline auth flow** | HIGH | The `offline_sessions` table stores a cached user profile but there is no IPC channel for `offline:auth:login` or `offline:auth:validate`. The renderer's existing auth tokens must already be present. What happens when the user opens the app fully offline with no prior session? |
| **`bootstrap-ipc.test.ts` is missing** | MEDIUM | Bootstrap IPC handlers (status, start, resume) have no tests. |
| **No outbox pruning** | LOW | Synced/failed entries accumulate indefinitely. No retention policy. |
| **No queue priority** | LOW | Outbox ordering is purely chronological. No way to prioritize critical operations. |
| **`lastSyncAt` not updated by push-only sync** | MEDIUM | `setLastSyncAt` is only called in `pullAndApply`, not after a successful push via `replayOutbox`. |

---

## 5. What Must Be Proven by Tests

### 5.1 Critical (must have before `offline.enabled` can be `true`)

| Test area | Reason | Current status |
|-----------|--------|----------------|
| Products IPC handler registration + all 6 channels | No tests exist. All 6 IPC handlers are untested. | ❌ Missing file |
| Products CRUD operations (create/update/delete) | `products-local.test.ts` only tests search/find. Core CRUD has zero coverage. | ❌ Missing |
| Connectivity state transitions | `connectivity` is always `"unknown"`. No tests for online→offline→online transitions. | ❌ No implementation |
| Offline-first sale completion without network | Current tests are unit-level (DB only). No integration test proving the full IPC flow works without network. | ❌ No integration test |
| Bootstrap failure and recovery paths | `bootstrap-ipc.test.ts` is missing. Bootstrap status transitions (pending→in_progress→complete/failed) need test coverage. | ❌ Missing file |

### 5.2 High (should have for safe rollout)

| Test area | Reason | Current status |
|-----------|--------|----------------|
| Products `is_protected` guard | Protected products can be deleted locally today. Test must prove the guard works. | ❌ Not implemented |
| Outbox idempotency for product operations | Idempotency key format and uniqueness across create/update/delete. | ❌ Not tested |
| Fiscal blocking via IPC handler | `sales-ipc.test.ts` may cover this; need verification. | ⚠️ Partial |
| Degraded state after DB integrity failure | `offline-state.test.ts` covers degraded flag, but not the startup integrity check path. | ⚠️ Partial |
| Sales listing by date range | Not implemented. Must have when built. | ❌ Not implemented |

### 5.3 Medium (desirable)

| Test area | Reason |
|-----------|--------|
| Stock balance adjustment via products module | No way to adjust stock offline today. When built, needs tests. |
| Conflict resolution flow | Not implemented. Server conflict response handling needs tests. |
| Outbox retry with exponential backoff | Not implemented. Needs timing/stub tests. |
| Offline auth session expiry | Not implemented. Session stale-after-N-days logic needs tests. |

---

## 6. Scope Boundaries

### 6.1 In scope for this change
- Sales module offline operability (complete sales, view history, handle stock)
- Products module offline operability (CRUD, search, barcode lookup)
- Connectivity detection and state management
- IPC handler completeness and test coverage
- Outbox/sync correctness for sales and products
- Conflict handling surface for sales and products

### 6.2 Out of scope (explicitly)
- **Remote backend delivery** — The sync engine already has the push/pull protocol. The backend endpoints (`POST /sync/bootstrap`, `POST /sync/push`, `GET /sync/pull`, `POST /auth/revalidate`) are assumed to exist. This exploration does not cover backend implementation.
- **Promotions, Provider Purchases, Reports, Support modules** — These have their own IPC handlers and local modules but are not in scope for this change.
- **Fiscal/invoice sales** — Explicitly blocked offline by design. Not being changed.
- **Next.js renderer/frontend** — The renderer is in a separate repository (`frontend-management-market/supermarket-management-frontend`). The IPC bridge is the interface contract. UI changes are out of scope.

---

## 7. Recommendations for Proposal Phase

1. **Determine the `offline.enabled` strategy.** Should it remain gated (default `false`) with a progressive rollout plan, or should it become always-on for the Sales and Products modules? The config already has the flag — the proposal should define the rollout path.

2. **Define the connectivity detection mechanism.** Options: `navigator.onLine` relayed through preload, Electron `net.isOnline()`, or a periodic health-check ping to the backend. The simplest path is `navigator.onLine` + Electron online/offline events piped through an IPC channel.

3. **Decide on offline auth.** When the app opens fully offline for the first time, what happens? Options: (a) require at least one online bootstrap before offline works, (b) allow offline-only mode with no auth, (c) cached credential with periodic revalidation. The current `offline_sessions` table suggests option (c).

4. **Design the conflict resolution surface.** The `support` module already has `listOutbox`, `retryOutbox`, and `exportOutbox` IPC channels. The proposal should define whether these are sufficient for end-user conflict resolution or if a dedicated conflict UI channel is needed.

5. **Decide on sales listing scope.** Minimum viable: list by date range, sorted by created_at DESC, with pagination. The schema already supports this — it just needs a new local function and IPC channel.

6. **Prioritize the missing tests.** `products-ipc.test.ts` and the products-local CRUD tests are the highest-priority gaps. They should be written first (Strict TDD mode).

7. **Define the `connectivity` state contract.** Currently always `"unknown"`. The proposal should define when it transitions to `"online"` or `"offline"` and what IPC channel the renderer uses to observe changes (push from main or poll from renderer).

---

## 8. File Inventory

### 8.1 Source Files (relevant to scope)

```
src/main/
├── index.ts                  — App lifecycle, DB init, window creation
├── config.ts                 — DesktopConfig with offline.enabled gate
├── db.ts                     — SQLite lifecycle, WAL, migrations v1-v3
├── sales-local.ts            — completeOfflineSale + types
├── sales-ipc.ts              — IPC handlers: complete, get
├── products-local.ts         — CRUD + search + findByCode
├── products-ipc.ts           — IPC handlers: 6 channels
├── offline-state.ts          — OfflineState type, getOfflineState()
├── offline-ipc.ts            — IPC handler: get-state
├── bootstrap.ts              — Snapshot ingestion, start/resume
├── bootstrap-ipc.ts          — IPC handlers: status, start, resume
├── sync-engine.ts            — Outbox replay, revalidation, markOutboxEntry
├── sync-ipc.ts               — IPC handlers: start, pull, get-state
├── pull-reconciliation.ts    — Pull changes, cursor safety
src/preload/
└── index.ts                  — contextBridge exposing marketDesktop API
```

### 8.2 Test Files

```
src/main/
├── sales-local.test.ts       — ✅ 15 tests
├── sales-ipc.test.ts         — ✅ Present
├── products-local.test.ts    — ⚠️ 12 tests (search + findByCode only; no CRUD tests)
├── products-ipc.test.ts      — ❌ MISSING
├── offline-state.test.ts     — ✅ 12 tests
├── sync-engine.test.ts       — ✅ 10 tests
├── sync-ipc.test.ts          — ✅ Present
├── pull-reconciliation.test.ts — ✅ Present
├── bootstrap.test.ts         — ✅ Present
├── bootstrap-ipc.test.ts     — ❌ MISSING
├── db.test.ts                — ✅ Present
├── config.test.ts            — ✅ Present
├── navigation.test.ts        — ✅ Present (not in scope)
```

### 8.3 Config Files

```
openspec/
└── config.yaml               — Project context, stack, Strict TDD mode
```

---

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `better-sqlite3` rebuild fails on target Node.js | Medium | High (no DB = no offline) | Prebuilt binaries or fallback to `sql.js` WASM |
| Renderer (Next.js) assumes always-online API | High | High (UI breaks when offline) | Preload bridge must be the single source of truth; renderer must use `window.marketDesktop` exclusively |
| Outbox grows unbounded without pruning | Medium | Medium (disk + sync time) | Add retention policy (e.g., delete synced entries older than 30 days) |
| Data conflicts between local and server state | Medium | High (data integrity) | Conflict resolution UI + server wins by default with manual override |
| Offline feature flag causes confusion | Low | Low | Clear config documentation; progressive rollout |
| Strict TDD mode slows initial velocity | Low | Medium (quality gain) | Write tests first as required; the test patterns are already well-established |
