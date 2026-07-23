// ---------------------------------------------------------------------------
// Application: ReportService unit tests with mocked IReportsRepository.
//
// Strict TDD RED phase: imports fail until domain types and service exist.
// Proves the thin service boundary without Electron or SQLite.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";

// ---- RED: these imports will fail until domain + service are created ----
import type { IReportsRepository } from "../../domain/reports/reports-repository";
import type {
  OfflineReportResult,
  OfflineSalesSummary,
  OfflineRecentSale,
  OfflineStalenessInfo,
} from "../../domain/reports/report";
import { ReportService } from "./report-service";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function mockRepo(): IReportsRepository {
  return {
    getSalesSummary: vi.fn(),
    getRecentSales: vi.fn(),
    getStaleness: vi.fn(),
  };
}

const makeSalesSummaryResult = (): OfflineReportResult<OfflineSalesSummary> => ({
  success: true,
  data: { totalSales: 5, totalRevenue: "500.00", periodStart: "2026-01-01", periodEnd: "2026-12-31" },
});

const makeRecentSalesResult = (): OfflineReportResult<OfflineRecentSale[]> => ({
  success: true,
  data: [
    { id: "s1", total: "100.00", customer: "Alice", invoiceStatus: "completed", createdAt: "2026-07-01T10:00:00Z" },
  ],
});

const makeStalenessResult = (): OfflineReportResult<OfflineStalenessInfo> => ({
  success: true,
  data: { lastSyncAt: "2026-07-20T12:00:00Z", pendingCount: 0, isStale: false },
  staleness: "live",
});

// ---------------------------------------------------------------------------
// Service delegation tests
// ---------------------------------------------------------------------------

describe("ReportService", () => {
  describe("getSalesSummary", () => {
    it("delegates to repository.getSalesSummary() and returns the same object identity", () => {
      const repo = mockRepo();
      const svc = new ReportService(repo);
      const expected = makeSalesSummaryResult();

      (repo.getSalesSummary as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.getSalesSummary();
      expect(repo.getSalesSummary).toHaveBeenCalledOnce();
      expect(result).toBe(expected);
    });

    it("passes through failure results unchanged", () => {
      const repo = mockRepo();
      const svc = new ReportService(repo);
      const failure: OfflineReportResult<OfflineSalesSummary> = {
        success: false,
        error: "DB unavailable",
        staleness: "unavailable",
      };

      (repo.getSalesSummary as ReturnType<typeof vi.fn>).mockReturnValue(failure);

      const result = svc.getSalesSummary();
      expect(result.success).toBe(false);
      expect(result.error).toBe("DB unavailable");
      expect(result.staleness).toBe("unavailable");
    });
  });

  describe("getRecentSales", () => {
    it("delegates to repository.getRecentSales(limit) and returns the same object identity", () => {
      const repo = mockRepo();
      const svc = new ReportService(repo);
      const expected = makeRecentSalesResult();

      (repo.getRecentSales as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.getRecentSales(5);
      expect(repo.getRecentSales).toHaveBeenCalledWith(5);
      expect(result).toBe(expected);
    });

    it("delegates with undefined limit when called without argument", () => {
      const repo = mockRepo();
      const svc = new ReportService(repo);
      const expected = makeRecentSalesResult();

      (repo.getRecentSales as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.getRecentSales();
      expect(repo.getRecentSales).toHaveBeenCalledWith(undefined);
      expect(result).toBe(expected);
    });

    it("passes through failure results unchanged", () => {
      const repo = mockRepo();
      const svc = new ReportService(repo);
      const failure: OfflineReportResult<OfflineRecentSale[]> = {
        success: false,
        error: "DB unavailable",
        staleness: "unavailable",
      };

      (repo.getRecentSales as ReturnType<typeof vi.fn>).mockReturnValue(failure);

      const result = svc.getRecentSales(10);
      expect(result.success).toBe(false);
      expect(result.error).toBe("DB unavailable");
    });
  });

  describe("getStaleness", () => {
    it("delegates to repository.getStaleness() and returns the same object identity", () => {
      const repo = mockRepo();
      const svc = new ReportService(repo);
      const expected = makeStalenessResult();

      (repo.getStaleness as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.getStaleness();
      expect(repo.getStaleness).toHaveBeenCalledOnce();
      expect(result).toBe(expected);
    });

    it("passes through failure results unchanged", () => {
      const repo = mockRepo();
      const svc = new ReportService(repo);
      const failure: OfflineReportResult<OfflineStalenessInfo> = {
        success: false,
        error: "DB unavailable",
        staleness: "unavailable",
      };

      (repo.getStaleness as ReturnType<typeof vi.fn>).mockReturnValue(failure);

      const result = svc.getStaleness();
      expect(result.success).toBe(false);
      expect(result.error).toBe("DB unavailable");
    });
  });
});
