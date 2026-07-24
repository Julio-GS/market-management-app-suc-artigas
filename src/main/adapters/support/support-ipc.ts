// ---------------------------------------------------------------------------
// Adapter: Support IPC handler registration/unregistration
//
// Electron IPC adapter: channel constants, type re-exports,
// registration/unregistration, payload pass-through, legacy error mapping.
// Does not import better-sqlite3, call getDb, or perform SQL.
// ---------------------------------------------------------------------------

import { ipcMain } from "electron";
import { SupportService } from "../../application/support/support-service";
import type { BusyTracker } from "../../busy-state";
import type {
  OutboxListFilter,
  OutboxListItem,
  OutboxRetryResult,
} from "../../domain/support/support";

// ---------------------------------------------------------------------------
// Channel constants (preserved byte-identical from legacy)
// ---------------------------------------------------------------------------

export const SUPPORT_CHANNELS = {
  LIST_OUTBOX: "outbox:list",
  RETRY_OUTBOX: "outbox:retry",
  RETRY_SALE: "outbox:retry-sale",
  RESOLVE_CONFLICT: "outbox:resolve-conflict",
  EXPORT_OUTBOX: "outbox:export",
} as const;

// ---------------------------------------------------------------------------
// Type re-exports (so preload can import from one module)
// ---------------------------------------------------------------------------

export type {
  OutboxListFilter,
  OutboxListItem,
  OutboxRetryResult,
  ResolveConflictParams,
  RetryOutboxOptions,
} from "../../domain/support/support";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerSupportIpc(
  supportService: SupportService,
  busyTracker?: BusyTracker,
): void {
  ipcMain.handle(
    SUPPORT_CHANNELS.LIST_OUTBOX,
    (_event, filter?: OutboxListFilter): OutboxListItem[] => {
      try {
        return supportService.listOutbox(filter);
      } catch {
        return [];
      }
    },
  );

  ipcMain.handle(
    SUPPORT_CHANNELS.RETRY_OUTBOX,
    (_event, outboxId: string, opts?: { confirmManualFix?: boolean }): Promise<OutboxRetryResult> | OutboxRetryResult => {
      const run = async () => {
        try {
          return supportService.retryOutbox(outboxId, opts);
        } catch (err) {
          return {
            success: false,
            error:
              err instanceof Error
                ? err.message
                : "Unknown error retrying outbox entry",
          };
        }
      };

      return busyTracker?.runProtectedOperation("support", "Retry outbox entry", run) ?? run();
    },
  );

  ipcMain.handle(
    SUPPORT_CHANNELS.RETRY_SALE,
    (_event, saleId: string): Promise<OutboxRetryResult> | OutboxRetryResult => {
      const run = async () => {
        try {
          return supportService.retrySale(saleId);
        } catch (err) {
          return {
            success: false,
            error:
              err instanceof Error
                ? err.message
                : "Unknown error retrying sale outbox entries",
          };
        }
      };

      return busyTracker?.runProtectedOperation("support", "Retry sale outbox", run) ?? run();
    },
  );

  ipcMain.handle(
    SUPPORT_CHANNELS.RESOLVE_CONFLICT,
    (
      _event,
      outboxId: string,
      params: { resolution: "keep_local" | "use_server" },
    ): Promise<OutboxRetryResult> | OutboxRetryResult => {
      const run = async () => {
        try {
          return supportService.resolveConflict(outboxId, params);
        } catch (err) {
          return {
            success: false,
            error:
              err instanceof Error
                ? err.message
                : "Unknown error resolving conflict",
          };
        }
      };

      return busyTracker?.runProtectedOperation("support", "Resolve conflict", run) ?? run();
    },
  );

  ipcMain.handle(
    SUPPORT_CHANNELS.EXPORT_OUTBOX,
    (): OutboxListItem[] => {
      try {
        return supportService.exportOutbox();
      } catch {
        return [];
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Unregistration
// ---------------------------------------------------------------------------

export function unregisterSupportIpc(): void {
  ipcMain.removeHandler(SUPPORT_CHANNELS.LIST_OUTBOX);
  ipcMain.removeHandler(SUPPORT_CHANNELS.RETRY_OUTBOX);
  ipcMain.removeHandler(SUPPORT_CHANNELS.RETRY_SALE);
  ipcMain.removeHandler(SUPPORT_CHANNELS.RESOLVE_CONFLICT);
  ipcMain.removeHandler(SUPPORT_CHANNELS.EXPORT_OUTBOX);
}
