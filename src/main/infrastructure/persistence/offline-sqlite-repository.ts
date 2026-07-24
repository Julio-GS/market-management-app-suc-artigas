// ---------------------------------------------------------------------------
// Infrastructure: Offline SQLite repository
//
// Implements IOfflineRepository using better-sqlite3, fetch, and the shared
// infrastructure modules (offline-state, offline-auth, connectivity-state).
// Preserves legacy online-then-offline login fallback, timeout, JWT decode,
// network error classification, session/state behavior, and result shapes
// exactly as they were in src/main/offline-ipc.ts.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";
import type { IOfflineRepository } from "../../domain/offline/offline-repository";
import type {
  OfflineLoginIpcResult,
  OfflineLoginParams,
  OfflineSessionIpcResult,
  OfflineState,
} from "../../domain/offline/offline";
import { toOfflineSessionIpcResult } from "../../domain/offline/offline";
import { getOfflineState, INITIAL_OFFLINE_STATE } from "../../offline-state";
import { getConnectivityState } from "../../connectivity-state";
import {
  getOfflineSession,
  verifyOfflineCredentials,
  upsertOfflineSession,
  hashPassword,
} from "../../offline-auth";

export class OfflineSqliteRepository implements IOfflineRepository {
  constructor(private readonly getDb: () => Database.Database) {}

  // ---------------------------------------------------------------------------
  // getState
  // ---------------------------------------------------------------------------

  getState(): OfflineState {
    try {
      const db = this.getDb();
      return getOfflineState(db, getConnectivityState());
    } catch {
      return {
        ...INITIAL_OFFLINE_STATE,
        degraded: true,
        bootstrap: "failed",
      };
    }
  }

  // ---------------------------------------------------------------------------
  // getSession
  // ---------------------------------------------------------------------------

  getSession(): OfflineSessionIpcResult | null {
    try {
      const db = this.getDb();
      const session = getOfflineSession(db);
      return toOfflineSessionIpcResult(session);
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // login
  //
  // Strategy:
  //   1. Try to authenticate against the backend (online path).
  //   2. On success: store hashed password + session in SQLite, return token.
  //   3. On network failure: verify credentials against stored SQLite hash.
  //   4. On wrong password (online or offline): return error.
  // ---------------------------------------------------------------------------

  async login(params: OfflineLoginParams): Promise<OfflineLoginIpcResult> {
    try {
      const db = this.getDb();

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
  }
}
