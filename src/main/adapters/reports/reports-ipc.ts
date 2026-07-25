// ---------------------------------------------------------------------------
// Adapter: Reports IPC handlers
//
// Electron primary adapter. Owns REPORTS_CHANNELS, handler
// registration/unregistration, permissive limit casting, and legacy-compatible
// error mapping. Preserves the existing permissive casting behavior — no strict
// Products-style validation. Calls ReportService;
// does NOT import better-sqlite3 or call getDb().
// ---------------------------------------------------------------------------

import { ipcMain } from "electron";
import { REPORTS_CHANNELS } from "../../../shared/ipc-channels";
import type { ReportService } from "../../application/reports/report-service";
import type {
  OfflineRecentSale,
  OfflineReportResult,
  OfflineSalesSummary,
  OfflineStalenessInfo,
} from "../../domain/reports/report";

export { REPORTS_CHANNELS };

// Re-export for preload consumers
export type { OfflineRecentSale, OfflineReportResult, OfflineSalesSummary, OfflineStalenessInfo };

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerReportsIpc(reportService: ReportService): void {
  ipcMain.handle(
    REPORTS_CHANNELS.GET_SALES_SUMMARY,
    (_event): OfflineReportResult<OfflineSalesSummary> => {
      try {
        return reportService.getSalesSummary();
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : "Failed to compute report",
          staleness: "unavailable",
        };
      }
    },
  );

  ipcMain.handle(
    REPORTS_CHANNELS.GET_RECENT_SALES,
    (_event, limit: unknown): OfflineReportResult<OfflineRecentSale[]> => {
      try {
        // Permissive casting: null becomes undefined so the repository
        // applies its default limit. Non-number values pass through without
        // adapter-level rejection, matching legacy permissive behaviour.
        return reportService.getRecentSales((limit as number | null | undefined) ?? undefined);
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : "Failed to load recent sales",
          staleness: "unavailable",
        };
      }
    },
  );

  ipcMain.handle(
    REPORTS_CHANNELS.GET_STALENESS,
    (_event): OfflineReportResult<OfflineStalenessInfo> => {
      try {
        return reportService.getStaleness();
      } catch (err) {
        return {
          success: false,
          error: err instanceof Error ? err.message : "Failed to read staleness",
          staleness: "unavailable",
        };
      }
    },
  );
}

export function unregisterReportsIpc(): void {
  ipcMain.removeHandler(REPORTS_CHANNELS.GET_SALES_SUMMARY);
  ipcMain.removeHandler(REPORTS_CHANNELS.GET_RECENT_SALES);
  ipcMain.removeHandler(REPORTS_CHANNELS.GET_STALENESS);
}
