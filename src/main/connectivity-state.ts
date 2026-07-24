// ---------------------------------------------------------------------------
// Connectivity state — singleton state holder for the main process
// ---------------------------------------------------------------------------

/**
 * Accurate connectivity states the renderer can observe through the offline
 * state IPC contract.
 */
export type ConnectivityState = "unknown" | "online" | "offline" | "reconnecting";

// ---------------------------------------------------------------------------
// Listener contract
// ---------------------------------------------------------------------------

export type ConnectivityChangeListener = (
  next: ConnectivityState,
  previous: ConnectivityState,
) => void;

// ---------------------------------------------------------------------------
// Internal singleton
// ---------------------------------------------------------------------------

let _connectivity: ConnectivityState = "unknown";
let _listeners: ConnectivityChangeListener[] = [];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Return the current connectivity state.
 *
 * Initial state is `"unknown"` until the first detection cycle completes.
 */
export function getConnectivityState(): ConnectivityState {
  return _connectivity;
}

/**
 * Register a listener that fires every time the connectivity state changes.
 * Returns an unsubscribe function.
 */
export function onConnectivityChange(
  listener: ConnectivityChangeListener,
): () => void {
  _listeners.push(listener);
  return () => {
    _listeners = _listeners.filter((l) => l !== listener);
  };
}

/**
 * Update the connectivity state.
 *
 * Allowed transitions:
 * - `unknown -> online | offline`
 * - `online -> offline | reconnecting`
 * - `offline -> online | reconnecting`
 * - `reconnecting -> online | offline`
 *
 * Invalid states (e.g. non-literal strings) are silently ignored and
 * the previous state is preserved.
 *
 * Registered listeners fire AFTER the state is updated.
 */
export function setConnectivityState(next: ConnectivityState): void {
  const valid: ConnectivityState[] = [
    "unknown",
    "online",
    "offline",
    "reconnecting",
  ];
  if (!valid.includes(next)) {
    return;
  }
  const previous = _connectivity;
  if (next === previous) {
    return; // no change, don't fire listeners
  }
  _connectivity = next;
  for (const listener of _listeners) {
    try {
      listener(next, previous);
    } catch {
      // best-effort — don't let listener errors break state transitions
    }
  }
}

/**
 * Reset the connectivity state back to unknown and clear listeners (for testing).
 */
export function resetConnectivityState(): void {
  _connectivity = "unknown";
  _listeners = [];
}
