import { randomUUID } from "node:crypto";

/**
 * Kinds of protected operations that should block update install/restart.
 */
export type BusyKind = "sale" | "payment" | "write" | "sync" | "bootstrap" | "support";

export interface BusyReason {
  token: string;
  kind: BusyKind;
  label?: string;
  /** Track which renderer view created this token so we can clean up on destroy. */
  webContentsId?: number;
}

export interface BusyState {
  busy: boolean;
  reasons: BusyReason[];
}

export type BusyListener = (state: BusyState) => void;

export interface BusyTracker {
  /** Start a protected operation. Returns an opaque token. */
  begin(kind: BusyKind, label?: string, opts?: { webContentsId?: number }): string;

  /** End a protected operation by token. No-op if the token is not active. */
  end(token: string): void;

  /** Whether any protected operation is currently active. */
  isBusy(): boolean;

  /** Snapshot of the current state. */
  getState(): BusyState;

  /** Register a listener that fires only when `busy` transitions (idle→busy or busy→idle). */
  onChange(listener: BusyListener): () => void;

  /**
   * Run an async function inside a protected scope.
   * The token is automatically cleared on success or failure.
   */
  runProtectedOperation<T>(
    kind: BusyKind,
    label: string | undefined,
    fn: () => Promise<T>,
    opts?: { webContentsId?: number },
  ): Promise<T>;

  /** Remove all tokens associated with a given WebContents id (call on destroy). */
  clearTokensForRendererView(webContentsId: number): void;
}

export function createBusyTracker(): BusyTracker {
  const reasons: BusyReason[] = [];
  const listeners = new Set<BusyListener>();

  function snapshot(): BusyState {
    return { busy: reasons.length > 0, reasons: [...reasons] };
  }

  function notify(previous: BusyState, next: BusyState): void {
    // Only fire on actual busy/idle transitions.
    if (previous.busy === next.busy) return;
    for (const listener of listeners) {
      try {
        listener(next);
      } catch {
        // Best-effort; do not let listener errors break the tracker.
      }
    }
  }

  const tracker: BusyTracker = {
    begin(kind, label, opts) {
      const previous = snapshot();
      const token = randomUUID();
      reasons.push({ token, kind, label, webContentsId: opts?.webContentsId });
      notify(previous, snapshot());
      return token;
    },

    end(token) {
      const index = reasons.findIndex((r) => r.token === token);
      if (index === -1) return;
      const beforeRemove = snapshot();
      reasons.splice(index, 1);
      notify(beforeRemove, snapshot());
    },

    isBusy() {
      return reasons.length > 0;
    },

    getState() {
      return snapshot();
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async runProtectedOperation(kind, label, fn, opts) {
      const token = tracker.begin(kind, label, opts);
      try {
        return await fn();
      } finally {
        tracker.end(token);
      }
    },

    clearTokensForRendererView(webContentsId) {
      const previous = snapshot();
      let removed = false;
      for (let i = reasons.length - 1; i >= 0; i--) {
        if (reasons[i].webContentsId === webContentsId) {
          reasons.splice(i, 1);
          removed = true;
        }
      }
      if (removed) {
        notify(previous, snapshot());
      }
    },
  };

  return tracker;
}
