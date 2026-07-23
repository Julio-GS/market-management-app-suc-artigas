// ---------------------------------------------------------------------------
// Adapter: Support IPC handler tests
//
// Strict TDD RED phase: imports fail until domain, service, and adapter exist.
// Exercises the new production-path Support IPC adapter with a mocked
// SupportService. Preserves legacy error mapping and channel constants.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
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
import { SUPPORT_CHANNELS, registerSupportIpc, unregisterSupportIpc } from "./support-ipc";
import { SupportService } from "../../application/support/support-service";
import type { ISupportRepository } from "../../domain/support/support-repository";

function mockRepo(): ISupportRepository {
  return {
    listOutbox: vi.fn(),
    retryOutbox: vi.fn(),
    retrySale: vi.fn(),
    resolveConflict: vi.fn(),
    exportOutbox: vi.fn(),
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

describe("support-ipc (new adapter)", () => {
  let repo: ISupportRepository;
  let svc: SupportService;

  beforeEach(() => {
    repo = mockRepo();
    svc = new SupportService(repo);
    registerSupportIpc(svc);
  });

  afterEach(() => {
    try {
      unregisterSupportIpc();
    } catch {
      // already removed
    }
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Channel name preservation
  // -----------------------------------------------------------------------

  describe("channel constants", () => {
    it("preserves all five channel names byte-identical to legacy", () => {
      expect(SUPPORT_CHANNELS.LIST_OUTBOX).toBe("outbox:list");
      expect(SUPPORT_CHANNELS.RETRY_OUTBOX).toBe("outbox:retry");
      expect(SUPPORT_CHANNELS.RETRY_SALE).toBe("outbox:retry-sale");
      expect(SUPPORT_CHANNELS.RESOLVE_CONFLICT).toBe("outbox:resolve-conflict");
      expect(SUPPORT_CHANNELS.EXPORT_OUTBOX).toBe("outbox:export");
    });
  });

  // -----------------------------------------------------------------------
  // Registration
  // -----------------------------------------------------------------------

  describe("registerSupportIpc", () => {
    it("registers all five handlers", async () => {
      const { ipcMain } = await import("electron");
      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };

      expect(mockIpc._handlers.has(SUPPORT_CHANNELS.LIST_OUTBOX)).toBe(true);
      expect(mockIpc._handlers.has(SUPPORT_CHANNELS.RETRY_OUTBOX)).toBe(true);
      expect(mockIpc._handlers.has(SUPPORT_CHANNELS.RETRY_SALE)).toBe(true);
      expect(mockIpc._handlers.has(SUPPORT_CHANNELS.RESOLVE_CONFLICT)).toBe(true);
      expect(mockIpc._handlers.has(SUPPORT_CHANNELS.EXPORT_OUTBOX)).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Unregistration
  // -----------------------------------------------------------------------

  describe("unregisterSupportIpc", () => {
    it("removes all five handlers", async () => {
      const { ipcMain } = await import("electron");
      const mockIpc = ipcMain as unknown as {
        _handlers: Map<string, (...args: unknown[]) => unknown>;
      };

      unregisterSupportIpc();

      expect(mockIpc._handlers.has(SUPPORT_CHANNELS.LIST_OUTBOX)).toBe(false);
      expect(mockIpc._handlers.has(SUPPORT_CHANNELS.RETRY_OUTBOX)).toBe(false);
      expect(mockIpc._handlers.has(SUPPORT_CHANNELS.RETRY_SALE)).toBe(false);
      expect(mockIpc._handlers.has(SUPPORT_CHANNELS.RESOLVE_CONFLICT)).toBe(false);
      expect(mockIpc._handlers.has(SUPPORT_CHANNELS.EXPORT_OUTBOX)).toBe(false);
    });

    it("is safe to call multiple times", () => {
      unregisterSupportIpc();
      expect(() => unregisterSupportIpc()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // LIST_OUTBOX — delegation
  // -----------------------------------------------------------------------

  describe("LIST_OUTBOX handler", () => {
    it("delegates to service.listOutbox with filter and returns result", async () => {
      const expected = [{ id: "ob-1" }];
      (repo.listOutbox as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(SUPPORT_CHANNELS.LIST_OUTBOX);
      const result = await handler({}, { status: "failed" });

      expect(repo.listOutbox).toHaveBeenCalledExactlyOnceWith({ status: "failed" });
      expect(result).toBe(expected);
    });

    it("delegates with undefined filter when not provided", async () => {
      const expected: unknown[] = [];
      (repo.listOutbox as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(SUPPORT_CHANNELS.LIST_OUTBOX);
      const result = await handler({});

      expect(repo.listOutbox).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(result).toBe(expected);
    });

    it("returns [] when service throws an Error", async () => {
      (repo.listOutbox as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      const handler = await getHandler(SUPPORT_CHANNELS.LIST_OUTBOX);
      const result = await handler({});

      expect(result).toEqual([]);
    });

    it("returns [] when service throws a non-Error value", async () => {
      (repo.listOutbox as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw "some string error";
      });

      const handler = await getHandler(SUPPORT_CHANNELS.LIST_OUTBOX);
      const result = await handler({});

      expect(result).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // RETRY_OUTBOX — delegation and error mapping
  // -----------------------------------------------------------------------

  describe("RETRY_OUTBOX handler", () => {
    it("delegates to service.retryOutbox with id and opts", async () => {
      const expected = { success: true };
      (repo.retryOutbox as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(SUPPORT_CHANNELS.RETRY_OUTBOX);
      const result = await handler({}, "ob-1", { confirmManualFix: true });

      expect(repo.retryOutbox).toHaveBeenCalledExactlyOnceWith("ob-1", { confirmManualFix: true });
      expect(result).toBe(expected);
    });

    it("delegates without opts when not provided", async () => {
      const expected = { success: false, error: "not found" };
      (repo.retryOutbox as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(SUPPORT_CHANNELS.RETRY_OUTBOX);
      const result = await handler({}, "ob-2");

      expect(repo.retryOutbox).toHaveBeenCalledExactlyOnceWith("ob-2", undefined);
      expect(result).toBe(expected);
    });

    it("returns legacy error result when service throws an Error", async () => {
      (repo.retryOutbox as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      const handler = await getHandler(SUPPORT_CHANNELS.RETRY_OUTBOX);
      const result = (await handler({}, "ob-1")) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("DB unavailable");
    });

    it("returns unknown error fallback when service throws a non-Error", async () => {
      (repo.retryOutbox as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw 42;
      });

      const handler = await getHandler(SUPPORT_CHANNELS.RETRY_OUTBOX);
      const result = (await handler({}, "ob-1")) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown error retrying outbox entry");
    });
  });

  // -----------------------------------------------------------------------
  // RETRY_SALE — delegation and error mapping
  // -----------------------------------------------------------------------

  describe("RETRY_SALE handler", () => {
    it("delegates to service.retrySale with saleId", async () => {
      const expected = { success: true, resetCount: 3 };
      (repo.retrySale as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(SUPPORT_CHANNELS.RETRY_SALE);
      const result = await handler({}, "sale-1");

      expect(repo.retrySale).toHaveBeenCalledExactlyOnceWith("sale-1");
      expect(result).toBe(expected);
    });

    it("returns legacy error result when service throws an Error", async () => {
      (repo.retrySale as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Transaction failed");
      });

      const handler = await getHandler(SUPPORT_CHANNELS.RETRY_SALE);
      const result = (await handler({}, "sale-1")) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Transaction failed");
    });

    it("returns unknown error fallback when service throws a non-Error", async () => {
      (repo.retrySale as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw null;
      });

      const handler = await getHandler(SUPPORT_CHANNELS.RETRY_SALE);
      const result = (await handler({}, "sale-1")) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown error retrying sale outbox entries");
    });
  });

  // -----------------------------------------------------------------------
  // RESOLVE_CONFLICT — delegation and error mapping
  // -----------------------------------------------------------------------

  describe("RESOLVE_CONFLICT handler", () => {
    it("delegates to service.resolveConflict with id and params", async () => {
      const expected = { success: true };
      (repo.resolveConflict as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(SUPPORT_CHANNELS.RESOLVE_CONFLICT);
      const result = await handler({}, "ob-bc", { resolution: "keep_local" });

      expect(repo.resolveConflict).toHaveBeenCalledExactlyOnceWith("ob-bc", { resolution: "keep_local" });
      expect(result).toBe(expected);
    });

    it("delegates use_server resolution", async () => {
      const expected = { success: true };
      (repo.resolveConflict as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(SUPPORT_CHANNELS.RESOLVE_CONFLICT);
      const result = await handler({}, "ob-bc", { resolution: "use_server" });

      expect(repo.resolveConflict).toHaveBeenCalledExactlyOnceWith("ob-bc", { resolution: "use_server" });
      expect(result).toBe(expected);
    });

    it("returns legacy error result when service throws an Error", async () => {
      (repo.resolveConflict as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      const handler = await getHandler(SUPPORT_CHANNELS.RESOLVE_CONFLICT);
      const result = (await handler({}, "ob-1", { resolution: "keep_local" })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("DB unavailable");
    });

    it("returns unknown error fallback when service throws a non-Error", async () => {
      (repo.resolveConflict as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw undefined;
      });

      const handler = await getHandler(SUPPORT_CHANNELS.RESOLVE_CONFLICT);
      const result = (await handler({}, "ob-1", { resolution: "keep_local" })) as { success: boolean; error: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Unknown error resolving conflict");
    });
  });

  // -----------------------------------------------------------------------
  // EXPORT_OUTBOX — delegation and error swallowing
  // -----------------------------------------------------------------------

  describe("EXPORT_OUTBOX handler", () => {
    it("delegates to service.exportOutbox and returns result", async () => {
      const expected = [{ id: "ob-1" }];
      (repo.exportOutbox as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(SUPPORT_CHANNELS.EXPORT_OUTBOX);
      const result = await handler({});

      expect(repo.exportOutbox).toHaveBeenCalledExactlyOnceWith();
      expect(result).toBe(expected);
    });

    it("returns [] when service throws an Error", async () => {
      (repo.exportOutbox as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      const handler = await getHandler(SUPPORT_CHANNELS.EXPORT_OUTBOX);
      const result = await handler({});

      expect(result).toEqual([]);
    });

    it("returns [] when service throws a non-Error value", async () => {
      (repo.exportOutbox as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw "some error";
      });

      const handler = await getHandler(SUPPORT_CHANNELS.EXPORT_OUTBOX);
      const result = await handler({});

      expect(result).toEqual([]);
    });
  });
});
