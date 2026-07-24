# Products Specification

## Purpose

Define the offline-operable behavior for the Products module: CRUD operations and search while offline, durable sync queueing, deterministic conflict resolution using last-write-wins by local device timestamp, and preservation of definitively rejected product operations for manual fix.

## Requirements

### Requirement: Offline Product CRUD

The system MUST allow eligible offline users to create, update, delete, search, and barcode-lookup products while the device is offline. Each mutating operation MUST persist the product change in local SQLite atomically within a single transaction.

#### Scenario: Create a product while offline

- GIVEN a previously authenticated user is operating on the device
- AND the device is offline
- WHEN the user creates a new product with valid data
- THEN the product is persisted in local SQLite
- AND the response includes the created product record

#### Scenario: Update a product while offline

- GIVEN a product exists in local SQLite
- WHEN the user updates the product with valid changed fields
- THEN the product record in local SQLite reflects the updated values
- AND unchanged fields retain their previous values

#### Scenario: Delete a product while offline

- GIVEN a product exists in local SQLite
- AND the product is not protected (`is_protected = false`)
- WHEN the user deletes the product
- THEN the product is removed from the local `products` table

#### Scenario: Search products while offline

- GIVEN products exist in local SQLite
- WHEN the user searches by partial name or barcode
- THEN matching products are returned ordered by name ascending

#### Scenario: Barcode lookup while offline

- GIVEN a product with a matching barcode exists in local SQLite
- WHEN the user looks up by barcode
- THEN the matching product is returned with all fields

### Requirement: Protected Product Constraint

The system MUST prevent deletion of products flagged as protected (`is_protected = true`). Protected products are server-managed and MUST NOT be deletable from the local device.

#### Scenario: Delete a protected product is rejected

- GIVEN a product with `is_protected = true`
- WHEN the user attempts to delete the product
- THEN the system MUST reject the operation
- AND the product MUST remain in local SQLite

### Requirement: Durable Sync Queueing for Products

The system MUST create an outbox entry for each product create, update, or delete operation within the same database transaction as the product change. The outbox entry MUST use an idempotency key to prevent duplicate server-side application.

#### Scenario: Outbox entry created atomically with product create

- GIVEN a user creates a new product offline
- WHEN the product transaction commits
- THEN an outbox entry with entity type `product_create` is present in the `outbox` table
- AND the outbox entry status is `pending`

#### Scenario: Outbox entry created atomically with product update

- GIVEN a user updates an existing product offline
- WHEN the product transaction commits
- THEN an outbox entry with entity type `product_update` is present in the `outbox` table
- AND the outbox entry status is `pending`

#### Scenario: Outbox entry created atomically with product delete

- GIVEN a user deletes a non-protected product offline
- WHEN the product transaction commits
- THEN an outbox entry with entity type `product_delete` is present in the `outbox` table
- AND the outbox entry status is `pending`

### Requirement: Product Conflict Resolution — Last-Write-Wins

When the server reports a conflict for a product operation during sync, the system MUST resolve the conflict using last-write-wins (LWW) based on the local device timestamp of the product operation. The write with the later timestamp wins. The system MUST record and expose the local device timestamp used for conflict resolution.

#### Scenario: Local product update is newer than server version

- GIVEN a local product update with device timestamp T1
- AND the server has a conflicting version with timestamp T0 where T1 > T0
- WHEN the conflict is evaluated during sync
- THEN the local version wins
- AND the local product record is pushed to the server

#### Scenario: Server product version is newer than local

- GIVEN a local product update with device timestamp T0
- AND the server has a conflicting version with timestamp T1 where T1 > T0
- WHEN the conflict is evaluated during sync
- THEN the server version wins
- AND the local product record is updated with the server version

#### Scenario: LWW timestamp is recorded

- GIVEN a product create, update, or delete is performed offline
- WHEN the outbox entry is created
- THEN the local device timestamp at the time of the operation is recorded
- AND the timestamp is available for conflict resolution

### Requirement: Clock Skew Risk Acknowledgement

The system MUST document that incorrect device clocks can produce incorrect product conflict outcomes under LWW. The system SHOULD surface the local device timestamp used for product operations where useful for debugging and operational awareness.

#### Scenario: Clock skew risk is documented

- GIVEN the product conflict resolution uses local device timestamps
- WHEN the system is deployed
- THEN operational documentation includes the clock-skew risk for LWW
- AND the risk is surfaced to operators and support teams

### Requirement: Definitive Product Rejection Preservation

When the server definitively rejects a product outbox entry (non-retryable rejection), the system MUST NOT delete or silently overwrite the local product record. The local record MUST be marked as requiring manual fix and remain visible to the user.

#### Scenario: Server definitively rejects a product create

- GIVEN a product create outbox entry is sent to the server during sync
- AND the server returns a definitive (non-retryable) rejection
- THEN the outbox entry is marked with a rejection/manual-fix status
- AND the local product record remains in SQLite
- AND the product is visible to the user as requiring manual fix

#### Scenario: Server definitively rejects a product update

- GIVEN a product update outbox entry is sent to the server during sync
- AND the server returns a definitive (non-retryable) rejection
- THEN the outbox entry is marked with a rejection/manual-fix status
- AND the local product record retains its pre-rejection state
- AND the product is visible to the user as requiring manual fix

#### Scenario: Rejected product not silently deleted

- GIVEN a product operation was definitively rejected by the server
- WHEN the user queries local products or sync state
- THEN the rejected product operation is still present
- AND its status indicates manual fix is required
