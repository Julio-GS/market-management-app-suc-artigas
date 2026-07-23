// ---------------------------------------------------------------------------
// Domain: Reports repository port
//
// Pure interface for existing read-only report operations. Contains no
// Electron, SQLite, infrastructure, application, or adapter imports.
// ---------------------------------------------------------------------------

import type {
  OfflineRecentSale,
  OfflineReportResult,
  OfflineSalesSummary,
  OfflineStalenessInfo,
} from "./report";

export interface IReportsRepository {
  getSalesSummary(): OfflineReportResult<OfflineSalesSummary>;
  getRecentSales(limit?: number): OfflineReportResult<OfflineRecentSale[]>;
  getStaleness(): OfflineReportResult<OfflineStalenessInfo>;
}
