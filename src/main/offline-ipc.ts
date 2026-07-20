import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import { getOfflineState, INITIAL_OFFLINE_STATE, type OfflineState } from "./offline-state";

// ---------------------------------------------------------------------------
// IPC channel constants
// ---------------------------------------------------------------------------

export const OFFLINE_CHANNELS = {
  GET_STATE: "offline:get-state",
} as const;

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register all offline-related IPC handlers on the main process.
 *
 * Each handler receives a function that returns the current database instance
 * so the handlers never hold a stale reference across DB close/reopen cycles.
 *
 * When the database is unavailable (getDb throws), the handler returns a
 * degraded OfflineState so the renderer can always query state and act on
 * the degraded flag.
 */
export function registerOfflineIpc(getDb: () => Database.Database): void {
  ipcMain.handle(OFFLINE_CHANNELS.GET_STATE, (): OfflineState => {
    try {
      const db = getDb();
      return getOfflineState(db);
    } catch {
      return {
        ...INITIAL_OFFLINE_STATE,
        degraded: true,
        bootstrap: "failed",
      };
    }
  });
}

/**
 * Remove all offline IPC handlers. Call during app shutdown or when
 * tearing down the DB.
 */
export function unregisterOfflineIpc(): void {
  ipcMain.removeHandler(OFFLINE_CHANNELS.GET_STATE);
}
