// ---------------------------------------------------------------------------
// Domain: Reports types
//
// Pure report result and data types. Contains no Electron, SQLite,
// infrastructure, application, or adapter imports.
// ---------------------------------------------------------------------------

export type OfflineReportStaleness = "live" | "stale" | "unavailable";

export interface OfflineReportResult<T = unknown> {
  success: boolean;
  data?: T;
  staleness?: OfflineReportStaleness;
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

export interface OfflineStalenessInfo {
  lastSyncAt: string | null;
  pendingCount: number;
  isStale: boolean;
}
