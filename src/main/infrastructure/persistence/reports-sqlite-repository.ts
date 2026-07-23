// ---------------------------------------------------------------------------
// Infrastructure: Reports SQLite repository
//
// Read-only implementation of IReportsRepository. Moves the legacy SELECT
// SQL, row mapping, and staleness computation from src/main/reports-ipc.ts
// without adding auth, outbox writes, transactions, or revalidation.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";
import type { IReportsRepository } from "../../domain/reports/reports-repository";
import type {
  OfflineRecentSale,
  OfflineReportResult,
  OfflineSalesSummary,
  OfflineStalenessInfo,
} from "../../domain/reports/report";

export class ReportsSqliteRepository implements IReportsRepository {
  constructor(private readonly getDb: () => Database.Database) {}

  // ---------------------------------------------------------------------------
  // Sales summary
  // ---------------------------------------------------------------------------

  getSalesSummary(): OfflineReportResult<OfflineSalesSummary> {
    const db = this.getDb();

    const lastSync = db
      .prepare("SELECT value FROM metadata WHERE key = 'last_sync_at'")
      .get() as { value: string } | undefined;
    const syncedAt = lastSync?.value ?? null;

    const row = db
      .prepare(
        `
      SELECT
        COUNT(*) as totalSales,
        COALESCE(SUM(CAST(total AS REAL)), 0) as totalRevenue,
        MIN(created_at) as firstSale,
        MAX(created_at) as lastSale
      FROM sales
    `,
      )
      .get() as
      | { totalSales: number; totalRevenue: number; firstSale: string | null; lastSale: string | null }
      | undefined;

    if (!row || row.totalSales === 0) {
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
      data: {
        totalSales: row.totalSales,
        totalRevenue: row.totalRevenue.toFixed(2),
        periodStart: row.firstSale ?? "",
        periodEnd: row.lastSale ?? "",
      },
      staleness,
      stalenessReason: syncedAt
        ? `Data includes unsynced local sales. Last server sync: ${syncedAt}. Revenue may not reflect backend-aggregated totals.`
        : "Local-only data. Connect to sync for backend-aggregated totals.",
    };
  }

  // ---------------------------------------------------------------------------
  // Recent sales
  // ---------------------------------------------------------------------------

  getRecentSales(limit?: number): OfflineReportResult<OfflineRecentSale[]> {
    const db = this.getDb();
    const effectiveLimit = limit ?? 10;

    const rows = db
      .prepare(
        `
      SELECT id, total, customer, invoice_status, created_at
      FROM sales
      ORDER BY created_at DESC
      LIMIT ?
    `,
      )
      .all(effectiveLimit) as {
      id: string;
      total: string;
      customer: string;
      invoice_status: string;
      created_at: string;
    }[];

    const sales: OfflineRecentSale[] = rows.map((r) => ({
      id: r.id,
      total: r.total,
      customer: r.customer,
      invoiceStatus: r.invoice_status,
      createdAt: r.created_at,
    }));

    const lastSync = db
      .prepare("SELECT value FROM metadata WHERE key = 'last_sync_at'")
      .get() as { value: string } | undefined;

    return {
      success: true,
      data: sales,
      staleness: lastSync?.value ? "stale" : "live",
      stalenessReason: lastSync?.value
        ? `Showing ${sales.length} local sales. May not include all server-synced sales. Last sync: ${lastSync.value}`
        : `Showing ${sales.length} local sales. Connect to sync for complete history.`,
    };
  }

  // ---------------------------------------------------------------------------
  // Staleness
  // ---------------------------------------------------------------------------

  getStaleness(): OfflineReportResult<OfflineStalenessInfo> {
    const db = this.getDb();

    const lastSync = db
      .prepare("SELECT value FROM metadata WHERE key = 'last_sync_at'")
      .get() as { value: string } | undefined;

    const pending = db
      .prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'pending'")
      .get() as { c: number };

    return {
      success: true,
      data: {
        lastSyncAt: lastSync?.value || null,
        pendingCount: pending.c,
        isStale: !lastSync?.value || pending.c > 0,
      },
      staleness: !lastSync?.value ? "unavailable" : pending.c > 0 ? "stale" : "live",
    };
  }
}
