// ---------------------------------------------------------------------------
// Adapter: Bootstrap IPC handlers
//
// Owns channel constants, Electron registration/unregistration, type
// re-exports, handler delegation, and legacy handler catch/error mapping.
// ---------------------------------------------------------------------------

import { ipcMain } from "electron";
import type { BootstrapService } from "../../application/bootstrap/bootstrap-service";
import type { BootstrapResult } from "../../domain/bootstrap/bootstrap";
import type { BusyTracker } from "../../busy-state";

// Re-export for preload consumers
export type { BootstrapResult } from "../../domain/bootstrap/bootstrap";

// ---------------------------------------------------------------------------
// IPC channel constants (byte-identical to legacy)
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
 * @param bootstrapService The bootstrap application service.
 */
export function registerBootstrapIpc(
  bootstrapService: BootstrapService,
  busyTracker?: BusyTracker,
): void {
  ipcMain.handle(BOOTSTRAP_CHANNELS.BOOTSTRAP_STATUS, (): BootstrapResult => {
    try {
      return bootstrapService.getStatus();
    } catch {
      return {
        status: "failed",
        ready: false,
        syncCursor: null,
        error: "Database unavailable",
      };
    }
  });

  ipcMain.handle(
    BOOTSTRAP_CHANNELS.BOOTSTRAP_START,
    async (
      _event,
      params: { token: string; apiBaseUrl: string },
    ): Promise<BootstrapResult> => {
      const run = async (): Promise<BootstrapResult> => {
        try {
          return await bootstrapService.start(params.token, params.apiBaseUrl);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Bootstrap failed";
          const failure: BootstrapResult = {
            status: "failed",
            ready: false,
            syncCursor: null,
            error: message,
          };
          return failure;
        }
      };

      return busyTracker?.runProtectedOperation("bootstrap", "Start bootstrap", run) ?? run();
    },
  );

  ipcMain.handle(
    BOOTSTRAP_CHANNELS.BOOTSTRAP_RESUME,
    async (
      _event,
      params: { token: string; apiBaseUrl: string },
    ): Promise<BootstrapResult> => {
      const run = async (): Promise<BootstrapResult> => {
        try {
          return await bootstrapService.resume(params.token, params.apiBaseUrl);
        } catch (err) {
          const message =
            err instanceof Error ? err.message : "Bootstrap resume failed";
          const failure: BootstrapResult = {
            status: "failed",
            ready: false,
            syncCursor: null,
            error: message,
          };
          return failure;
        }
      };

      return busyTracker?.runProtectedOperation("bootstrap", "Resume bootstrap", run) ?? run();
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
