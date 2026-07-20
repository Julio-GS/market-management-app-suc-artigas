import { ipcMain } from "electron";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OfflineReportResult<T = unknown> {
  success: boolean;
  data?: T;
  staleness?: "live" | "stale" | "unavailable";
  stalenessReason?: string;
  error?: string;
}

export interface OfflineSalesSummary {
  totalSales: number;
  totalRevenue: string;
  periodStart: string;
  periodEnd: string;
}

export interface OfflineRecentSale {
  id: string;
  total: string;
  customer: string;
  invoiceStatus: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Channel constants
// ---------------------------------------------------------------------------

export const REPORTS_CHANNELS = {
  GET_SALES_SUMMARY: "offline:reports:sales-summary",
  GET_RECENT_SALES: "offline:reports:recent-sales",
  GET_STALENESS: "offline:reports:staleness",
} as const;

// ---------------------------------------------------------------------------
// Report operations
// ---------------------------------------------------------------------------

function computeLocalSalesSummary(db: Database.Database): OfflineSalesSummary | null {
  const row = db.prepare(`
    SELECT
      COUNT(*) as totalSales,
      COALESCE(SUM(CAST(total AS REAL)), 0) as totalRevenue,
      MIN(created_at) as firstSale,
      MAX(created_at) as lastSale
    FROM sales
  `).get() as { totalSales: number; totalRevenue: number; firstSale: string | null; lastSale: string | null } | undefined;

  if (!row || row.totalSales === 0) return null;

  return {
    totalSales: row.totalSales,
    totalRevenue: row.totalRevenue.toFixed(2),
    periodStart: row.firstSale ?? "",
    periodEnd: row.lastSale ?? "",
  };
}

function computeLocalRecentSales(db: Database.Database, limit = 10): OfflineRecentSale[] {
  const rows = db.prepare(`
    SELECT id, total, customer, invoice_status, created_at
    FROM sales
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit) as { id: string; total: string; customer: string; invoice_status: string; created_at: string }[];

  return rows.map((r) => ({
    id: r.id,
    total: r.total,
    customer: r.customer,
    invoiceStatus: r.invoice_status,
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerReportsIpc(getDb: () => Database.Database): void {
  ipcMain.handle(
    REPORTS_CHANNELS.GET_SALES_SUMMARY,
    (_event): OfflineReportResult<OfflineSalesSummary> => {
      try {
        const db = getDb();
        const lastSync = db.prepare("SELECT value FROM metadata WHERE key = 'last_sync_at'").get() as { value: string } | undefined;
        const syncedAt = lastSync?.value ?? null;

        const summary = computeLocalSalesSummary(db);

        if (!summary) {
          return {
            success: true,
            data: { totalSales: 0, totalRevenue: "0.00", periodStart: "", periodEnd: "" },
            staleness: "stale",
            stalenessReason: syncedAt
              ? `No local sales found. Last synced: ${syncedAt}`
              : "No data available offline. Connect to sync.",
          };
        }

        const staleness: "live" | "stale" = syncedAt ? "stale" : "live";
        return {
          success: true,
          data: summary,
          staleness,
          stalenessReason: syncedAt
            ? `Data includes unsynced local sales. Last server sync: ${syncedAt}. Revenue may not reflect backend-aggregated totals.`
            : "Local-only data. Connect to sync for backend-aggregated totals.",
        };
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
    (_event, limit?: number): OfflineReportResult<OfflineRecentSale[]> => {
      try {
        const db = getDb();
        const sales = computeLocalRecentSales(db, limit ?? 10);
        const lastSync = db.prepare("SELECT value FROM metadata WHERE key = 'last_sync_at'").get() as { value: string } | undefined;

        return {
          success: true,
          data: sales,
          staleness: lastSync?.value ? "stale" : "live",
          stalenessReason: lastSync?.value
            ? `Showing ${sales.length} local sales. May not include all server-synced sales. Last sync: ${lastSync.value}`
            : `Showing ${sales.length} local sales. Connect to sync for complete history.`,
        };
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
    (_event): OfflineReportResult<{ lastSyncAt: string | null; pendingCount: number; isStale: boolean }> => {
      try {
        const db = getDb();
        const lastSync = db.prepare("SELECT value FROM metadata WHERE key = 'last_sync_at'").get() as { value: string } | undefined;
        const pending = db.prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'pending'").get() as { c: number };

        return {
          success: true,
          data: {
            lastSyncAt: lastSync?.value || null,
            pendingCount: pending.c,
            isStale: !lastSync?.value || pending.c > 0,
          },
          staleness: !lastSync?.value ? "unavailable" : pending.c > 0 ? "stale" : "live",
        };
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
