# Sales Specification

## Purpose

Define the offline-operable behavior for the Sales module: completing non-fiscal sales while offline, immediate local stock decrement, durable sync queueing, sync state visibility, and preservation of definitively rejected records for manual fix.

## Requirements

### Requirement: Offline Sale Completion

The system MUST allow eligible offline users to complete non-fiscal sales while the device is offline. A completed offline sale MUST persist the sale record, sale items, and payment entries in local SQLite atomically within a single transaction.

#### Scenario: Complete a non-fiscal sale while offline

- GIVEN a previously authenticated user is operating on the device
- AND the device is offline
- WHEN the user completes a non-fiscal sale with valid items and payments
- THEN the sale, sale items, and payments are persisted in local SQLite
- AND the response includes the completed sale record

#### Scenario: Fiscal sale completion remains blocked offline

- GIVEN a user attempts to complete a sale with `invoiceRequested: true`
- WHEN the sale completion is attempted
- THEN the system MUST reject the operation with a fiscal-blocked error
- AND no sale, sale items, payments, stock movements, or outbox entries are persisted

### Requirement: Immediate Local Stock Decrement

The system MUST decrement local SQLite stock balances immediately when a sale is completed for any product flagged as stock-managed (`maneja_stock`). Stock movements MUST be recorded in the `stock_movements` audit trail. Negative stock MUST be permitted with a warning; reconciliation with the server occurs during sync.

#### Scenario: Stock-managed product decremented on sale

- GIVEN a product with `maneja_stock = true` and current local stock of 10
- WHEN a sale is completed that includes 3 units of that product
- THEN the local `stock_balances` entry for that product MUST reflect stock of 7
- AND a `stock_movements` audit record is created for the deduction

#### Scenario: Negative stock allowed with warning

- GIVEN a product with `maneja_stock = true` and current local stock of 2
- WHEN a sale is completed that includes 5 units of that product
- THEN the local stock MUST become negative (-3)
- AND the sale result MUST include a negative-stock warning
- AND the sale is still persisted and queued for sync

### Requirement: Durable Sync Queueing for Sales

The system MUST create an outbox entry for each completed sale and for each stock impact within the same database transaction as the sale persistence. The outbox entry MUST use an idempotency key prefixed with the installation ID to prevent duplicate server-side application.

#### Scenario: Outbox entry created atomically with sale

- GIVEN a user completes a valid offline sale
- WHEN the sale transaction commits
- THEN an outbox entry with entity type `sale` is present in the `outbox` table
- AND the outbox entry status is `pending`
- AND the outbox entry idempotency key includes the installation ID prefix

#### Scenario: Outbox entry survives app restart

- GIVEN a sale was completed and an outbox entry was created
- WHEN the application is restarted
- THEN the outbox entry for that sale is still present with `pending` status
- AND the sale record is still present in local SQLite

### Requirement: Sale Sync State Visibility

The system MUST expose the sync state of each sale outbox entry so that users can identify whether a sale is pending sync, failed, blocked by auth, blocked by conflict, requires manual fix, or has been synced.

#### Scenario: User views pending sale sync status

- GIVEN a sale was completed offline and its outbox entry is `pending`
- WHEN the user queries sync state for sales
- THEN the sale is shown with a `pending` sync status

#### Scenario: User views failed sale sync status

- GIVEN a sale outbox entry transitioned to `failed` after a retryable sync error
- WHEN the user queries sync state for sales
- THEN the sale is shown with a `failed` sync status

### Requirement: Definitive Sale Rejection Preservation

When the server definitively rejects a sale outbox entry (non-retryable rejection), the system MUST NOT delete the local sale record. The local record MUST be marked as requiring manual fix and remain visible to the user.

#### Scenario: Server definitively rejects a sale

- GIVEN a sale outbox entry is sent to the server during sync
- AND the server returns a definitive (non-retryable) rejection
- THEN the outbox entry is marked with a rejection/manual-fix status
- AND the local sale record, sale items, payments, and stock movements remain intact in SQLite
- AND the sale is visible to the user as requiring manual fix

#### Scenario: Rejected sale not silently deleted

- GIVEN a sale was definitively rejected by the server
- WHEN the user queries local sales
- THEN the rejected sale is still present in local results
- AND its status indicates manual fix is required
