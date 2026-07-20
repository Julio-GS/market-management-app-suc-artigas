import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import { getBootstrapStatus, startBootstrap, resumeBootstrap, type BootstrapResult } from "./bootstrap";

// ---------------------------------------------------------------------------
// IPC channel constants
// ---------------------------------------------------------------------------

export const BOOTSTRAP_CHANNELS = {
  BOOTSTRAP_STATUS: "offline:bootstrap:status",
  BOOTSTRAP_START: "offline:bootstrap:start",
  BOOTSTRAP_RESUME: "offline:bootstrap:resume",
} as const;

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register all bootstrap-related IPC handlers.
 *
 * @param getDb   Returns the current database instance.
 */
export function registerBootstrapIpc(getDb: () => Database.Database): void {
  ipcMain.handle(BOOTSTRAP_CHANNELS.BOOTSTRAP_STATUS, (): BootstrapResult => {
    try {
      const db = getDb();
      return getBootstrapStatus(db);
    } catch {
      return { status: "failed", ready: false, syncCursor: null, error: "Database unavailable" };
    }
  });

  ipcMain.handle(
    BOOTSTRAP_CHANNELS.BOOTSTRAP_START,
    async (_event, params: { token: string; apiBaseUrl: string }): Promise<BootstrapResult> => {
      try {
        const db = getDb();
        return await startBootstrap(db, params.token, params.apiBaseUrl);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Bootstrap failed";
        return { status: "failed", ready: false, syncCursor: null, error: message };
      }
    },
  );

  ipcMain.handle(
    BOOTSTRAP_CHANNELS.BOOTSTRAP_RESUME,
    async (_event, params: { token: string; apiBaseUrl: string }): Promise<BootstrapResult> => {
      try {
        const db = getDb();
        return await resumeBootstrap(db, params.token, params.apiBaseUrl);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Bootstrap resume failed";
        return { status: "failed", ready: false, syncCursor: null, error: message };
      }
    },
  );
}

/**
 * Remove all bootstrap IPC handlers.
 */
export function unregisterBootstrapIpc(): void {
  ipcMain.removeHandler(BOOTSTRAP_CHANNELS.BOOTSTRAP_STATUS);
  ipcMain.removeHandler(BOOTSTRAP_CHANNELS.BOOTSTRAP_START);
  ipcMain.removeHandler(BOOTSTRAP_CHANNELS.BOOTSTRAP_RESUME);
}
