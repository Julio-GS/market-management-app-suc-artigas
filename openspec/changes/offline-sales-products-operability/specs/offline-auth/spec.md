# Offline Auth Specification

## Purpose

Define the offline authentication and session behavior for the desktop app: who may operate offline, how token expiry is handled during offline operation, and how authorization is revalidated before sync after reconnect.

## Requirements

### Requirement: Offline Session Eligibility

The system MUST allow offline operation only for users who have previously logged in successfully on the same device. A cached user profile MUST be stored locally upon successful login to support subsequent offline sessions.

#### Scenario: Previously authenticated user operates offline

- GIVEN a user has logged in successfully on this device at least once
- AND the user's profile is cached in the local `offline_sessions` table
- WHEN the device is offline
- THEN the user MAY perform supported offline Sales and Products operations

#### Scenario: Never-logged-in user cannot operate offline

- GIVEN a user has never logged in on this device
- AND no cached profile exists for this user locally
- WHEN the device is offline
- THEN the system MUST reject any attempt to perform offline Sales or Products operations
- AND the user MUST be informed that a prior login is required

### Requirement: Token Expiry During Offline Operation

If the user's authentication token expires while the device is offline, the system MUST keep the local offline session operational for eligible offline workflows. Token expiry MUST NOT terminate the ability to complete sales, manage products, or perform other supported offline operations.

#### Scenario: Token expires while offline, local session remains operational

- GIVEN a user is operating offline
- AND the user's authentication token has expired
- WHEN the user attempts to complete a sale or product operation
- THEN the operation MUST succeed locally
- AND the local data is persisted with an outbox entry for later sync

#### Scenario: App restarts while offline with expired token

- GIVEN a user's token expired during a previous offline session
- WHEN the app is restarted while still offline
- THEN the local offline session MUST remain operational using the cached profile
- AND supported offline operations MUST still succeed locally

### Requirement: No Maximum Offline Session Age

The system MUST NOT impose a maximum stale-session age for offline operation. A previously authenticated user MAY operate offline indefinitely until the device reconnects. Authorization is revalidated at reconnect time, not by a local timeout.

#### Scenario: Long offline period does not block local operation

- GIVEN a user has been offline for an extended period (days or weeks)
- AND the cached profile still exists locally
- WHEN the user performs an offline operation
- THEN the operation MUST succeed locally
- AND an outbox entry is created for later sync

### Requirement: Reconnect Authorization Revalidation Gate

When the device reconnects after an offline period, the system MUST revalidate the user's authorization with the server BEFORE pushing any queued outbox entries. Sync MUST NOT proceed until revalidation succeeds.

#### Scenario: Revalidation succeeds, sync proceeds

- GIVEN the device reconnects after an offline period
- AND outbox entries are pending
- WHEN the sync process starts
- THEN the system MUST first revalidate authorization with the server
- AND upon successful revalidation, the system MAY push pending outbox entries

#### Scenario: Revalidation blocks sync

- GIVEN the device reconnects after an offline period
- AND outbox entries are pending
- WHEN the sync process starts
- AND the server rejects the revalidation (e.g. user no longer authorized)
- THEN the system MUST NOT push any pending outbox entries
- AND all pending outbox entries MUST remain in their current state (not deleted or silently discarded)

### Requirement: Authorization Rejection After Reconnect

If the server rejects authorization during revalidation after reconnect, the system MUST block all sync operations. Local records created during offline operation MUST be preserved and marked as blocked or requiring manual attention. The user MUST be informed that authorization could not be revalidated.

#### Scenario: Revalidation failure preserves local records

- GIVEN offline work was performed while disconnected
- AND the server rejects authorization during revalidation on reconnect
- THEN all local offline records (sales, products, stock movements) remain in SQLite
- AND affected outbox entries are marked as blocked by auth
- AND the user is informed that sync is blocked due to authorization failure

#### Scenario: User can inspect blocked records after auth rejection

- GIVEN sync is blocked due to authorization rejection
- WHEN the user queries sync state
- THEN the blocked outbox entries are visible with their blocked status
- AND the associated local records (sales, products) remain queryable
