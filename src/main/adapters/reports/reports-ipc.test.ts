// ---------------------------------------------------------------------------
// Adapter: Reports IPC handler tests
//
// Strict TDD RED phase: imports fail until domain, service, and adapter exist.
// Exercises the new production-path Reports IPC adapter with a mocked
// ReportService. Preserves legacy-compatible permissive limit casting and
// error mapping — no strict Products-style validation.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
      _handlers: handlers,
    },
  };
});

// ---- RED: these imports will fail until domain + service + adapter exist ----
import { REPORTS_CHANNELS, registerReportsIpc, unregisterReportsIpc } from "./reports-ipc";
import { ReportService } from "../../application/reports/report-service";
import type { IReportsRepository } from "../../domain/reports/reports-repository";

function mockRepo(): IReportsRepository {
  return {
    getSalesSummary: vi.fn(),
    getRecentSales: vi.fn(),
    getStaleness: vi.fn(),
  };
}

async function getHandler(channel: string) {
  const { ipcMain } = await import("electron");
  const mockIpc = ipcMain as unknown as {
    _handlers: Map<string, (...args: unknown[]) => unknown>;
  };
  const handler = mockIpc._handlers.get(channel);
  expect(handler).toBeTypeOf("function");
  return handler!;
}

describe("reports-ipc (new adapter)", () => {
  let repo: IReportsRepository;
  let svc: ReportService;

  beforeEach(() => {
    repo = mockRepo();
    svc = new ReportService(repo);
    registerReportsIpc(svc);
  });

  afterEach(() => {
    try {
      unregisterReportsIpc();
    } catch {
      // already removed
    }
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Channel name preservation
  // -----------------------------------------------------------------------

  describe("channel name preservation", () => {
    it("uses the same channel names as the legacy IPC adapter", () => {
      expect(REPORTS_CHANNELS.GET_SALES_SUMMARY).toBe("offline:reports:sales-summary");
      expect(REPORTS_CHANNELS.GET_RECENT_SALES).toBe("offline:reports:recent-sales");
      expect(REPORTS_CHANNELS.GET_STALENESS).toBe("offline:reports:staleness");
    });
  });

  // -----------------------------------------------------------------------
  // GET_SALES_SUMMARY
  // -----------------------------------------------------------------------

  describe("GET_SALES_SUMMARY", () => {
    it("delegates to service.getSalesSummary() and returns its result", async () => {
      const expected = { success: true, data: { totalSales: 5, totalRevenue: "500.00", periodStart: "", periodEnd: "" } };
      (repo.getSalesSummary as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(REPORTS_CHANNELS.GET_SALES_SUMMARY);
      const result = handler({});

      expect(result).toBe(expected);
      expect(repo.getSalesSummary).toHaveBeenCalledOnce();
    });

    it("maps thrown Error to legacy fallback with staleness 'unavailable'", async () => {
      (repo.getSalesSummary as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      const handler = await getHandler(REPORTS_CHANNELS.GET_SALES_SUMMARY);
      const result = handler({}) as { success: boolean; error?: string; staleness?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("DB unavailable");
      expect(result.staleness).toBe("unavailable");
    });

    it("maps non-Error throws to fallback 'Failed to compute report'", async () => {
      (repo.getSalesSummary as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw "raw string error";
      });

      const handler = await getHandler(REPORTS_CHANNELS.GET_SALES_SUMMARY);
      const result = handler({}) as { success: boolean; error?: string; staleness?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to compute report");
      expect(result.staleness).toBe("unavailable");
    });
  });

  // -----------------------------------------------------------------------
  // GET_RECENT_SALES — permissive limit casting
  // -----------------------------------------------------------------------

  describe("GET_RECENT_SALES", () => {
    it("delegates to service.getRecentSales(limit) with explicit limit", async () => {
      const expected = { success: true, data: [{ id: "s1", total: "100.00", customer: "A", invoiceStatus: "completed", createdAt: "2026-07-01" }] };
      (repo.getRecentSales as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(REPORTS_CHANNELS.GET_RECENT_SALES);
      const result = handler({}, 5);

      expect(result).toBe(expected);
      expect(repo.getRecentSales).toHaveBeenCalledWith(5);
    });

    it("passes null as undefined (default path) — permissive casting", async () => {
      const expected = { success: true, data: [] };
      (repo.getRecentSales as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(REPORTS_CHANNELS.GET_RECENT_SALES);
      const result = handler({}, null);

      expect(result).toBe(expected);
      // null should be cast to undefined so the repository applies its default limit
      expect(repo.getRecentSales).toHaveBeenCalledWith(undefined);
    });

    it("does not reject non-number values — permissive behaviour", async () => {
      const expected = { success: true, data: [] };
      (repo.getRecentSales as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(REPORTS_CHANNELS.GET_RECENT_SALES);
      const result = handler({}, "not-a-number");

      // Permissive: passes through whatever was given; the repository handles
      // the invalid limit internally (likely as undefined).
      expect(result).toBe(expected);
    });

    it("delegates with undefined when called without limit argument", async () => {
      const expected = { success: true, data: [] };
      (repo.getRecentSales as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(REPORTS_CHANNELS.GET_RECENT_SALES);
      const result = handler({});

      expect(result).toBe(expected);
      expect(repo.getRecentSales).toHaveBeenCalledWith(undefined);
    });

    it("maps thrown Error to legacy fallback with staleness 'unavailable'", async () => {
      (repo.getRecentSales as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      const handler = await getHandler(REPORTS_CHANNELS.GET_RECENT_SALES);
      const result = handler({}) as { success: boolean; error?: string; staleness?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("DB unavailable");
      expect(result.staleness).toBe("unavailable");
    });

    it("maps non-Error throws to fallback 'Failed to load recent sales'", async () => {
      (repo.getRecentSales as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw null;
      });

      const handler = await getHandler(REPORTS_CHANNELS.GET_RECENT_SALES);
      const result = handler({}) as { success: boolean; error?: string; staleness?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to load recent sales");
      expect(result.staleness).toBe("unavailable");
    });
  });

  // -----------------------------------------------------------------------
  // GET_STALENESS
  // -----------------------------------------------------------------------

  describe("GET_STALENESS", () => {
    it("delegates to service.getStaleness() and returns its result", async () => {
      const expected = {
        success: true,
        data: { lastSyncAt: "2026-07-20T12:00:00Z", pendingCount: 0, isStale: false },
        staleness: "live",
      };
      (repo.getStaleness as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(REPORTS_CHANNELS.GET_STALENESS);
      const result = handler({});

      expect(result).toBe(expected);
      expect(repo.getStaleness).toHaveBeenCalledOnce();
    });

    it("maps thrown Error to legacy fallback with staleness 'unavailable'", async () => {
      (repo.getStaleness as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      const handler = await getHandler(REPORTS_CHANNELS.GET_STALENESS);
      const result = handler({}) as { success: boolean; error?: string; staleness?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("DB unavailable");
      expect(result.staleness).toBe("unavailable");
    });

    it("maps non-Error throws to fallback 'Failed to read staleness'", async () => {
      (repo.getStaleness as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw undefined;
      });

      const handler = await getHandler(REPORTS_CHANNELS.GET_STALENESS);
      const result = handler({}) as { success: boolean; error?: string; staleness?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to read staleness");
      expect(result.staleness).toBe("unavailable");
    });
  });

  // -----------------------------------------------------------------------
  // Register / Unregister
  // -----------------------------------------------------------------------

  describe("registerReportsIpc", () => {
    it("registers all three handlers", async () => {
      const { ipcMain } = await import("electron");
      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, unknown>;
        handle: ReturnType<typeof vi.fn>;
      };

      // Re-register to get fresh handle mock calls
      vi.clearAllMocks();
      const freshRepo = mockRepo();
      const freshSvc = new ReportService(freshRepo);
      registerReportsIpc(freshSvc);

      expect(mockIpc.handle).toHaveBeenCalledWith(
        REPORTS_CHANNELS.GET_SALES_SUMMARY,
        expect.any(Function),
      );
      expect(mockIpc.handle).toHaveBeenCalledWith(
        REPORTS_CHANNELS.GET_RECENT_SALES,
        expect.any(Function),
      );
      expect(mockIpc.handle).toHaveBeenCalledWith(
        REPORTS_CHANNELS.GET_STALENESS,
        expect.any(Function),
      );
    });
  });

  describe("unregisterReportsIpc", () => {
    it("removes all three handlers", async () => {
      const { ipcMain } = await import("electron");
      unregisterReportsIpc();

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, unknown>;
        removeHandler: ReturnType<typeof vi.fn>;
      };

      expect(mockIpc.removeHandler).toHaveBeenCalledWith(REPORTS_CHANNELS.GET_SALES_SUMMARY);
      expect(mockIpc.removeHandler).toHaveBeenCalledWith(REPORTS_CHANNELS.GET_RECENT_SALES);
      expect(mockIpc.removeHandler).toHaveBeenCalledWith(REPORTS_CHANNELS.GET_STALENESS);
    });
  });
});
