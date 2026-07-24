// ---------------------------------------------------------------------------
// Domain: Offline IPC contract types and pure helpers
//
// Owns the renderer-visible contract currently exported by the legacy root IPC
// module. No Electron, SQLite, fetch, or process-global state imports allowed.
// ---------------------------------------------------------------------------

import type { OfflineState } from "../../offline-state";
import type { OfflineSession } from "../../offline-auth";

export type { OfflineState };

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

export interface OfflineLoginParams {
  username: string;
  password: string;
  /** Backend base URL used to attempt an online login first. */
  apiBaseUrl: string;
}

export interface OfflineLoginIpcResult {
  success: boolean;
  userId?: string;
  username?: string;
  /** JWT access token (only present on successful online login). */
  token?: string;
  /** True when authenticated locally (no network). */
  offlineMode?: boolean;
  error?: string;
}

export type OfflineSessionIpcResult = Omit<OfflineSession, "password_hash">;

// ---------------------------------------------------------------------------
// Pure helper
// ---------------------------------------------------------------------------

export function toOfflineSessionIpcResult(
  session: OfflineSession | null,
): OfflineSessionIpcResult | null {
  if (!session) return null;
  const { password_hash: _passwordHash, ...safeSession } = session;
  return safeSession;
}
