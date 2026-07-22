// ---------------------------------------------------------------------------
// Adapter: Promotions IPC handler tests
//
// Exercises the new production-path Promotions IPC adapter with a mocked
// PromotionService. Preserves legacy-compatible permissive casting and error
// mapping — no strict Products-style validation or errorCode values.
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

import { PROMOTIONS_CHANNELS, registerPromotionsIpc, unregisterPromotionsIpc } from "./promotions-ipc";
import { PromotionService } from "../../application/promotions/promotion-service";
import type { IPromotionsRepository } from "../../domain/promotions/promotions-repository";

function mockRepo(): IPromotionsRepository {
  return {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
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

describe("promotions-ipc (new adapter)", () => {
  let repo: IPromotionsRepository;
  let svc: PromotionService;

  beforeEach(() => {
    repo = mockRepo();
    svc = new PromotionService(repo);
    registerPromotionsIpc(svc);
  });

  afterEach(() => {
    try {
      unregisterPromotionsIpc();
    } catch {
      // already removed
    }
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // CREATE — legacy-compatible permissive casting (no strict validation)
  // -----------------------------------------------------------------------

  describe("CREATE", () => {
    it("delegates input unchanged to the service (permissive cast, no validation rejection)", async () => {
      const expected = {
        success: true as const,
        promotion: {
          id: "promo-1", name: "Summer Sale", description: null, scope: "product",
          productId: null, type: "percentage", discountPercent: 15,
          startDate: null, endDate: null, weekdays: null,
          enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01",
        },
      };
      (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(PROMOTIONS_CHANNELS.CREATE);
      const input = { name: "Summer Sale", type: "percentage", discount_percent: 15 };
      const result = handler({}, input) as { success: boolean; promotion?: { name: string } };

      expect(result.success).toBe(true);
      expect(result.promotion?.name).toBe("Summer Sale");
      expect(repo.create).toHaveBeenCalledWith(input);
    });

    it("catches thrown errors and returns legacy-compatible error result (no errorCode)", async () => {
      (repo.create as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Offline auth required");
      });

      const handler = await getHandler(PROMOTIONS_CHANNELS.CREATE);
      const result = handler({}, { name: "Fail", type: "percentage" }) as { success: boolean; error?: string; errorCode?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Offline auth required");
      expect(result.errorCode).toBeUndefined();
    });

    it("returns fallback error message for non-Error throws", async () => {
      (repo.create as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw "raw string error";
      });

      const handler = await getHandler(PROMOTIONS_CHANNELS.CREATE);
      const result = handler({}, { name: "Fail", type: "percentage" }) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to create promotion");
    });
  });

  // -----------------------------------------------------------------------
  // UPDATE — legacy-compatible permissive casting
  // -----------------------------------------------------------------------

  describe("UPDATE", () => {
    it("delegates promotionId and input unchanged to the service", async () => {
      const expected = {
        success: true as const,
        promotion: {
          id: "promo-1", name: "Updated Name", description: null, scope: "product",
          productId: null, type: "percentage", discountPercent: 25,
          startDate: null, endDate: null, weekdays: null,
          enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01",
        },
      };
      (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(PROMOTIONS_CHANNELS.UPDATE);
      const input = { name: "Updated Name", discount_percent: 25 };
      const result = handler({}, "promo-1", input) as { success: boolean; promotion?: { name: string } };

      expect(result.success).toBe(true);
      expect(result.promotion?.name).toBe("Updated Name");
      expect(repo.update).toHaveBeenCalledWith("promo-1", input);
    });

    it("catches thrown errors and returns legacy-compatible error result", async () => {
      (repo.update as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Promotion not found");
      });

      const handler = await getHandler(PROMOTIONS_CHANNELS.UPDATE);
      const result = handler({}, "nonexistent", { name: "Nope" }) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Promotion not found");
    });

    it("returns fallback error message for non-Error throws", async () => {
      (repo.update as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw null;
      });

      const handler = await getHandler(PROMOTIONS_CHANNELS.UPDATE);
      const result = handler({}, "x", {}) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to update promotion");
    });
  });

  // -----------------------------------------------------------------------
  // DELETE — legacy-compatible
  // -----------------------------------------------------------------------

  describe("DELETE", () => {
    it("delegates promotionId unchanged to the service", async () => {
      (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue({ success: true });

      const handler = await getHandler(PROMOTIONS_CHANNELS.DELETE);
      const result = handler({}, "promo-1") as { success: boolean };

      expect(result.success).toBe(true);
      expect(repo.delete).toHaveBeenCalledWith("promo-1");
    });

    it("catches thrown errors and returns legacy-compatible error result", async () => {
      (repo.delete as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Promotion not found");
      });

      const handler = await getHandler(PROMOTIONS_CHANNELS.DELETE);
      const result = handler({}, "nonexistent") as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Promotion not found");
    });

    it("returns fallback error message for non-Error throws", async () => {
      (repo.delete as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw undefined;
      });

      const handler = await getHandler(PROMOTIONS_CHANNELS.DELETE);
      const result = handler({}, "x") as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to delete promotion");
    });
  });

  // -----------------------------------------------------------------------
  // LIST — legacy-compatible
  // -----------------------------------------------------------------------

  describe("LIST", () => {
    it("delegates to service and returns results", async () => {
      const expected = [
        { success: true as const, promotion: { id: "p1", name: "A", description: null, scope: "product", productId: null, type: "percentage", discountPercent: null, startDate: null, endDate: null, weekdays: null, enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" } },
        { success: true as const, promotion: { id: "p2", name: "B", description: null, scope: "product", productId: null, type: "fixed", discountPercent: null, startDate: null, endDate: null, weekdays: null, enabled: true, createdAt: "2026-01-01", updatedAt: "2026-01-01" } },
      ];
      (repo.list as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(PROMOTIONS_CHANNELS.LIST);
      const result = handler({}) as Array<{ success: boolean }>;

      expect(result).toHaveLength(2);
      expect(result[0].success).toBe(true);
      expect(result[1].success).toBe(true);
    });

    it("catches thrown errors and wraps in array with error result", async () => {
      (repo.list as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      const handler = await getHandler(PROMOTIONS_CHANNELS.LIST);
      const result = handler({}) as Array<{ success: boolean; error?: string }>;

      expect(result).toHaveLength(1);
      expect(result[0].success).toBe(false);
      expect(result[0].error).toBe("DB unavailable");
    });

    it("returns fallback error message for non-Error throws", async () => {
      (repo.list as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw "raw";
      });

      const handler = await getHandler(PROMOTIONS_CHANNELS.LIST);
      const result = handler({}) as Array<{ success: boolean; error?: string }>;

      expect(result).toHaveLength(1);
      expect(result[0].success).toBe(false);
      expect(result[0].error).toBe("Failed to list promotions");
    });
  });

  // -----------------------------------------------------------------------
  // Channel name preservation
  // -----------------------------------------------------------------------

  describe("channel name preservation", () => {
    it("uses the same channel names as the legacy IPC adapter", () => {
      expect(PROMOTIONS_CHANNELS.CREATE).toBe("offline:promotions:create");
      expect(PROMOTIONS_CHANNELS.UPDATE).toBe("offline:promotions:update");
      expect(PROMOTIONS_CHANNELS.DELETE).toBe("offline:promotions:delete");
      expect(PROMOTIONS_CHANNELS.LIST).toBe("offline:promotions:list");
    });
  });

  // -----------------------------------------------------------------------
  // Unregister
  // -----------------------------------------------------------------------

  describe("unregisterPromotionsIpc", () => {
    it("removes all four handlers", async () => {
      const { ipcMain } = await import("electron");
      unregisterPromotionsIpc();

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, unknown>;
        removeHandler: ReturnType<typeof vi.fn>;
      };

      expect(mockIpc.removeHandler).toHaveBeenCalledWith(PROMOTIONS_CHANNELS.CREATE);
      expect(mockIpc.removeHandler).toHaveBeenCalledWith(PROMOTIONS_CHANNELS.UPDATE);
      expect(mockIpc.removeHandler).toHaveBeenCalledWith(PROMOTIONS_CHANNELS.DELETE);
      expect(mockIpc.removeHandler).toHaveBeenCalledWith(PROMOTIONS_CHANNELS.LIST);
    });
  });
});
