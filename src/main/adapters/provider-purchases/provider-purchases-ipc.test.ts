// ---------------------------------------------------------------------------
// Adapter: Provider Purchases IPC handler tests
//
// Exercises the new production-path Provider Purchases IPC adapter with a
// mocked ProviderPurchaseService. Preserves legacy-compatible permissive
// casting and error mapping — no strict Products-style validation or
// errorCode values.
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

import { PROVIDER_PURCHASES_CHANNELS, registerProviderPurchasesIpc, unregisterProviderPurchasesIpc } from "./provider-purchases-ipc";
import { ProviderPurchaseService } from "../../application/provider-purchases/provider-purchase-service";
import type { IProviderPurchasesRepository } from "../../domain/provider-purchases/provider-purchases-repository";

function mockRepo(): IProviderPurchasesRepository {
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

describe("provider-purchases-ipc (new adapter)", () => {
  let repo: IProviderPurchasesRepository;
  let svc: ProviderPurchaseService;

  beforeEach(() => {
    repo = mockRepo();
    svc = new ProviderPurchaseService(repo);
    registerProviderPurchasesIpc(svc);
  });

  afterEach(() => {
    try {
      unregisterProviderPurchasesIpc();
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
        purchase: {
          id: "pp-1", providerName: "ACME Corp", amount: "1500.00",
          paymentMethod: "transfer", createdAt: "2026-01-01", updatedAt: "2026-01-01",
        },
      };
      (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(PROVIDER_PURCHASES_CHANNELS.CREATE);
      const input = { provider_name: "ACME Corp", amount: "1500.00", payment_method: "transfer" };
      const result = handler({}, input) as { success: boolean; purchase?: { providerName: string } };

      expect(result.success).toBe(true);
      expect(result.purchase?.providerName).toBe("ACME Corp");
      expect(repo.create).toHaveBeenCalledWith(input);
    });

    it("catches thrown errors and returns legacy-compatible error result (no errorCode)", async () => {
      (repo.create as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Offline auth required");
      });

      const handler = await getHandler(PROVIDER_PURCHASES_CHANNELS.CREATE);
      const result = handler({}, { provider_name: "Fail", amount: "1.00" }) as { success: boolean; error?: string; errorCode?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Offline auth required");
      expect(result.errorCode).toBeUndefined();
    });

    it("returns fallback error message for non-Error throws", async () => {
      (repo.create as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw "raw string error";
      });

      const handler = await getHandler(PROVIDER_PURCHASES_CHANNELS.CREATE);
      const result = handler({}, { provider_name: "Fail", amount: "1.00" }) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to create purchase");
    });
  });

  // -----------------------------------------------------------------------
  // UPDATE — legacy-compatible permissive casting
  // -----------------------------------------------------------------------

  describe("UPDATE", () => {
    it("delegates purchaseId and input unchanged to the service", async () => {
      const expected = {
        success: true as const,
        purchase: {
          id: "pp-1", providerName: "Updated Corp", amount: "2000.00",
          paymentMethod: "card", createdAt: "2026-01-01", updatedAt: "2026-01-01",
        },
      };
      (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(PROVIDER_PURCHASES_CHANNELS.UPDATE);
      const input = { provider_name: "Updated Corp", amount: "2000.00" };
      const result = handler({}, "pp-1", input) as { success: boolean; purchase?: { providerName: string } };

      expect(result.success).toBe(true);
      expect(result.purchase?.providerName).toBe("Updated Corp");
      expect(repo.update).toHaveBeenCalledWith("pp-1", input);
    });

    it("catches thrown errors and returns legacy-compatible error result", async () => {
      (repo.update as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Provider purchase not found");
      });

      const handler = await getHandler(PROVIDER_PURCHASES_CHANNELS.UPDATE);
      const result = handler({}, "nonexistent", { provider_name: "Nope" }) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Provider purchase not found");
    });

    it("returns fallback error message for non-Error throws", async () => {
      (repo.update as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw null;
      });

      const handler = await getHandler(PROVIDER_PURCHASES_CHANNELS.UPDATE);
      const result = handler({}, "x", {}) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to update purchase");
    });
  });

  // -----------------------------------------------------------------------
  // DELETE — legacy-compatible
  // -----------------------------------------------------------------------

  describe("DELETE", () => {
    it("delegates purchaseId unchanged to the service", async () => {
      (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue({ success: true });

      const handler = await getHandler(PROVIDER_PURCHASES_CHANNELS.DELETE);
      const result = handler({}, "pp-1") as { success: boolean };

      expect(result.success).toBe(true);
      expect(repo.delete).toHaveBeenCalledWith("pp-1");
    });

    it("catches thrown errors and returns legacy-compatible error result", async () => {
      (repo.delete as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Provider purchase not found");
      });

      const handler = await getHandler(PROVIDER_PURCHASES_CHANNELS.DELETE);
      const result = handler({}, "nonexistent") as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Provider purchase not found");
    });

    it("returns fallback error message for non-Error throws", async () => {
      (repo.delete as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw undefined;
      });

      const handler = await getHandler(PROVIDER_PURCHASES_CHANNELS.DELETE);
      const result = handler({}, "x") as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to delete purchase");
    });
  });

  // -----------------------------------------------------------------------
  // LIST — legacy-compatible
  // -----------------------------------------------------------------------

  describe("LIST", () => {
    it("delegates to service and returns results", async () => {
      const expected = [
        { success: true as const, purchase: { id: "p1", providerName: "A", amount: "100.00", paymentMethod: null, createdAt: "2026-01-01", updatedAt: "2026-01-01" } },
        { success: true as const, purchase: { id: "p2", providerName: "B", amount: "200.00", paymentMethod: null, createdAt: "2026-01-01", updatedAt: "2026-01-01" } },
      ];
      (repo.list as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(PROVIDER_PURCHASES_CHANNELS.LIST);
      const result = handler({}) as Array<{ success: boolean }>;

      expect(result).toHaveLength(2);
      expect(result[0].success).toBe(true);
      expect(result[1].success).toBe(true);
    });

    it("catches thrown errors and wraps in array with error result", async () => {
      (repo.list as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      const handler = await getHandler(PROVIDER_PURCHASES_CHANNELS.LIST);
      const result = handler({}) as Array<{ success: boolean; error?: string }>;

      expect(result).toHaveLength(1);
      expect(result[0].success).toBe(false);
      expect(result[0].error).toBe("DB unavailable");
    });

    it("returns fallback error message for non-Error throws", async () => {
      (repo.list as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw "raw";
      });

      const handler = await getHandler(PROVIDER_PURCHASES_CHANNELS.LIST);
      const result = handler({}) as Array<{ success: boolean; error?: string }>;

      expect(result).toHaveLength(1);
      expect(result[0].success).toBe(false);
      expect(result[0].error).toBe("Failed to list purchases");
    });
  });

  // -----------------------------------------------------------------------
  // Channel name preservation
  // -----------------------------------------------------------------------

  describe("channel name preservation", () => {
    it("uses the same channel names as the legacy IPC adapter", () => {
      expect(PROVIDER_PURCHASES_CHANNELS.CREATE).toBe("offline:provider-purchases:create");
      expect(PROVIDER_PURCHASES_CHANNELS.UPDATE).toBe("offline:provider-purchases:update");
      expect(PROVIDER_PURCHASES_CHANNELS.LIST).toBe("offline:provider-purchases:list");
      expect(PROVIDER_PURCHASES_CHANNELS.DELETE).toBe("offline:provider-purchases:delete");
    });
  });

  // -----------------------------------------------------------------------
  // Unregister
  // -----------------------------------------------------------------------

  describe("unregisterProviderPurchasesIpc", () => {
    it("removes all four handlers", async () => {
      const { ipcMain } = await import("electron");
      unregisterProviderPurchasesIpc();

      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, unknown>;
        removeHandler: ReturnType<typeof vi.fn>;
      };

      expect(mockIpc.removeHandler).toHaveBeenCalledWith(PROVIDER_PURCHASES_CHANNELS.CREATE);
      expect(mockIpc.removeHandler).toHaveBeenCalledWith(PROVIDER_PURCHASES_CHANNELS.UPDATE);
      expect(mockIpc.removeHandler).toHaveBeenCalledWith(PROVIDER_PURCHASES_CHANNELS.LIST);
      expect(mockIpc.removeHandler).toHaveBeenCalledWith(PROVIDER_PURCHASES_CHANNELS.DELETE);
    });
  });
});
