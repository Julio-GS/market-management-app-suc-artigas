import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import { getOfflineState, INITIAL_OFFLINE_STATE, type OfflineState } from "./offline-state";
import { getConnectivityState } from "./connectivity-state";
import {
  getOfflineSession,
  verifyOfflineCredentials,
  upsertOfflineSession,
  hashPassword,
  type OfflineSession,
} from "./offline-auth";

// ---------------------------------------------------------------------------
// IPC channel constants
// ---------------------------------------------------------------------------

export const OFFLINE_CHANNELS = {
  GET_STATE: "offline:get-state",
  GET_SESSION: "offline:get-session",
  LOGIN: "offline:login",
} as const;

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

export function toOfflineSessionIpcResult(
  session: OfflineSession | null,
): OfflineSessionIpcResult | null {
  if (!session) return null;
  const { password_hash: _passwordHash, ...safeSession } = session;
  return safeSession;
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerOfflineIpc(getDb: () => Database.Database): void {
  // -------------------------------------------------------------------------
  // offline:get-state
  // -------------------------------------------------------------------------
  ipcMain.handle(OFFLINE_CHANNELS.GET_STATE, (): OfflineState => {
    try {
      const db = getDb();
      return getOfflineState(db, getConnectivityState());
    } catch {
      return {
        ...INITIAL_OFFLINE_STATE,
        degraded: true,
        bootstrap: "failed",
      };
    }
  });

  // -------------------------------------------------------------------------
  // offline:get-session
  // -------------------------------------------------------------------------
  ipcMain.handle(OFFLINE_CHANNELS.GET_SESSION, (): OfflineSessionIpcResult | null => {
    try {
      const db = getDb();
      return toOfflineSessionIpcResult(getOfflineSession(db));
    } catch {
      return null;
    }
  });

  // -------------------------------------------------------------------------
  // offline:login
  //
  // Strategy:
  //   1. Try to authenticate against the backend (online path).
  //   2. On success: store hashed password + session in SQLite, return token.
  //   3. On network failure: verify credentials against stored SQLite hash.
  //   4. On wrong password (online or offline): return error.
  // -------------------------------------------------------------------------
  ipcMain.handle(
    OFFLINE_CHANNELS.LOGIN,
    async (_event, params: OfflineLoginParams): Promise<OfflineLoginIpcResult> => {
      try {
        const db = getDb();

        // --- Online path ---
        try {
          const response = await fetch(`${params.apiBaseUrl}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              username: params.username,
              password: params.password,
            }),
            signal: AbortSignal.timeout(8000),
          });

          if (response.ok) {
            const data = (await response.json()) as { access_token: string };
            const token = data.access_token;

            // Decode user info from JWT (best-effort)
            let userId = `local:${params.username}`;
            try {
              const payload = JSON.parse(
                Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
              ) as { sub?: string };
              if (payload.sub) userId = payload.sub;
            } catch { /* ignore */ }

            // Persist credentials so future offline logins work
            const hash = hashPassword(params.password);
            upsertOfflineSession(db, userId, params.username, hash);

            return {
              success: true,
              userId,
              username: params.username,
              token,
              offlineMode: false,
            };
          }

          // Backend responded with an error (e.g., 401 wrong password)
          const body = await response.text();
          let message = `Login failed (${response.status})`;
          try {
            const parsed = JSON.parse(body) as { message?: string };
            if (parsed.message) message = parsed.message;
          } catch { /* ignore */ }
          return { success: false, error: message };

        } catch (networkErr) {
          // Network error or timeout - fall through to offline path
          const isNetworkError =
            networkErr instanceof TypeError ||
            (networkErr instanceof Error &&
              (networkErr.name === "AbortError" ||
               networkErr.name === "TimeoutError" ||
               networkErr.message.includes("fetch")));

          if (!isNetworkError) {
            throw networkErr;
          }
          // Fall through to offline verification below
        }

        // --- Offline path ---
        const result = verifyOfflineCredentials(db, params.username, params.password);
        if (!result.success) {
          return { success: false, error: result.error };
        }
        return {
          success: true,
          userId: result.userId,
          username: result.username,
          offlineMode: true,
        };

      } catch (err) {
        const message = err instanceof Error ? err.message : "Login error";
        return { success: false, error: message };
      }
    },
  );
}

/**
 * Remove all offline IPC handlers. Call during app shutdown or when
 * tearing down the DB.
 */
export function unregisterOfflineIpc(): void {
  ipcMain.removeHandler(OFFLINE_CHANNELS.GET_STATE);
  ipcMain.removeHandler(OFFLINE_CHANNELS.GET_SESSION);
  ipcMain.removeHandler(OFFLINE_CHANNELS.LOGIN);
}
