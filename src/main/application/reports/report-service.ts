// ---------------------------------------------------------------------------
// Application: ReportService use-case boundary
//
// Thin delegator to IReportsRepository. Contains no Electron, SQLite,
// staleness computation, validation, or error mapping logic.
// ---------------------------------------------------------------------------

import type { IReportsRepository } from "../../domain/reports/reports-repository";
import type {
  OfflineRecentSale,
  OfflineReportResult,
  OfflineSalesSummary,
  OfflineStalenessInfo,
} from "../../domain/reports/report";

export class ReportService {
  constructor(private readonly reportsRepository: IReportsRepository) {}

  getSalesSummary(): OfflineReportResult<OfflineSalesSummary> {
    return this.reportsRepository.getSalesSummary();
  }

  getRecentSales(limit?: number): OfflineReportResult<OfflineRecentSale[]> {
    return this.reportsRepository.getRecentSales(limit);
  }

  getStaleness(): OfflineReportResult<OfflineStalenessInfo> {
    return this.reportsRepository.getStaleness();
  }
}
