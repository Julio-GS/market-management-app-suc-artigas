// ---------------------------------------------------------------------------
// Pure LWW (last-write-wins) conflict resolution policy
//
// Extracted from src/main/sync-engine.ts — no infrastructure dependencies.
// ---------------------------------------------------------------------------

/**
 * Compare the local outbox timestamp against the server-provided version
 * timestamp and decide whether the local write wins.
 *
 * Returns `true` when the local timestamp is strictly later than the server
 * timestamp (local wins), `false` when the server timestamp is later or equal.
 *
 * Returns `null` when either timestamp is missing/invalid — the caller must
 * treat this as `blocked_conflict`.
 */
export function resolveLww(
  localTimestamp: string | null,
  serverTimestamp: string | null,
): boolean | null {
  if (!localTimestamp || !serverTimestamp) {
    return null; // missing metadata → blocked_conflict
  }

  const localMs = Date.parse(localTimestamp);
  const serverMs = Date.parse(serverTimestamp);

  if (Number.isNaN(localMs) || Number.isNaN(serverMs)) {
    return null; // unparseable → blocked_conflict
  }

  return localMs > serverMs;
}

/**
 * @deprecated Use the generic resolveLww instead.
 */
export function resolveProductLww(
  localTimestamp: string | null,
  serverTimestamp: string | null,
): boolean | null {
  return resolveLww(localTimestamp, serverTimestamp);
}
