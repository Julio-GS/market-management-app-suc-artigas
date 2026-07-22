# Sync State Specification

## Purpose

Define the connectivity state contract, sync state visibility, manual retry behavior, and rejection/conflict handling contracts that allow users to understand sync health and take recovery action for Sales and Products offline operations.

## Requirements

### Requirement: Connectivity State Contract

The system MUST maintain a connectivity state that accurately reflects whether the device is online, offline, or in a degraded/reconnecting condition. The connectivity state MUST be observable by the renderer through the existing offline state IPC contract.

#### Scenario: Device transitions from online to offline

- GIVEN the device is online with connectivity state `"online"`
- WHEN the network connection is lost
- THEN the connectivity state MUST transition to `"offline"`
- AND the renderer MUST be able to observe the updated state

#### Scenario: Device transitions from offline to online

- GIVEN the device is offline with connectivity state `"offline"`
- WHEN the network connection is restored
- THEN the connectivity state MUST transition to `"online"`
- AND the renderer MUST be able to observe the updated state

#### Scenario: Initial state before detection

- GIVEN the application has started and no connectivity check has completed
- WHEN the connectivity state is queried
- THEN the state MUST be `"unknown"` until a determination is made

### Requirement: Sync State Visibility

The system MUST expose the sync state of each outbox entry at a level of detail useful for Sales and Products operations. The exposed states MUST include at minimum: `pending`, `in_flight`, `synced`, `failed` (retryable), `blocked_auth`, `blocked_conflict`, and `manual_fix` (definitive rejection).

#### Scenario: User sees pending outbox count

- GIVEN there are 3 outbox entries in `pending` status for sales and products
- WHEN the user queries sync state
- THEN the response includes a pending count of 3

#### Scenario: User sees failed outbox entries

- GIVEN an outbox entry is in `failed` status after a retryable sync error
- WHEN the user queries sync state
- THEN the entry is visible with `failed` status
- AND the associated entity type (sale or product) is identifiable

#### Scenario: User sees blocked-auth entries

- GIVEN sync is blocked due to authorization revalidation failure
- WHEN the user queries sync state
- THEN affected outbox entries are visible with `blocked_auth` status

#### Scenario: User sees manual-fix entries

- GIVEN a server definitively rejected an outbox entry
- WHEN the user queries sync state
- THEN the entry is visible with `manual_fix` status
- AND the associated local record is still queryable

### Requirement: Manual Retry for Retryable Failures

The system MUST allow users to manually retry outbox entries that are in a retryable failure state (`failed`, `retry_wait`). The retry MUST re-enter the sync pipeline respecting ordered outbox guarantees.

#### Scenario: User retries a failed outbox entry

- GIVEN an outbox entry is in `failed` status
- WHEN the user triggers a manual retry for that entry
- THEN the outbox entry status transitions back to `pending`
- AND the sync engine will attempt to push the entry on the next sync cycle

#### Scenario: Manual retry preserves order guarantees

- GIVEN outbox entries A (pending) and B (failed) where A was created before B
- WHEN the user retries entry B
- THEN entry A MUST still be pushed before entry B
- AND the ordered delivery guarantee is preserved

### Requirement: Definitive Rejection Manual-Fix State

When the server definitively rejects an outbox entry (non-retryable), the system MUST transition that entry to a `manual_fix` state. The entry MUST NOT be automatically retried. The entry MUST NOT be deleted. The user MUST be able to identify the rejected record and take manual corrective action.

#### Scenario: Definitive rejection transitions to manual-fix

- GIVEN an outbox entry is in `in_flight` status during sync
- AND the server returns a definitive (non-retryable) rejection
- THEN the outbox entry status MUST transition to `manual_fix`
- AND the entry is not eligible for automatic retry

#### Scenario: Manual-fix entry is not auto-deleted

- GIVEN an outbox entry is in `manual_fix` status
- WHEN the sync cycle completes
- THEN the `manual_fix` entry remains in the `outbox` table
- AND the local record it references remains in SQLite

#### Scenario: Manual-fix entry visible for user action

- GIVEN an outbox entry is in `manual_fix` status
- WHEN the user queries sync state or outbox entries
- THEN the entry is visible with its `manual_fix` status
- AND the entry includes enough information for the user to identify the affected sale or product

### Requirement: Ordered Outbox Guarantee Preservation

The system MUST preserve the ordered outbox delivery guarantee: entries are pushed in creation order, and on first permanent failure during a sync cycle, all subsequent entries remain `pending` and are not pushed until the blocking entry is resolved.

#### Scenario: First failure blocks subsequent entries

- GIVEN outbox entries A, B, C in creation order, all `pending`
- WHEN sync pushes entry A and it fails definitively
- THEN entry A transitions to `manual_fix`
- AND entries B and C remain `pending`
- AND entries B and C are not pushed until entry A's blocking condition is resolved or bypassed

#### Scenario: Auth block prevents all pushes

- GIVEN outbox entries are pending
- AND authorization revalidation fails on reconnect
- THEN no outbox entries are pushed
- AND all pending entries remain in their current state
