import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusyTracker } from "./busy-state";
import type { SupportService } from "./application/support/support-service";

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

import { ipcMain } from "electron";
import {
  SUPPORT_CHANNELS,
  registerSupportIpc,
  unregisterSupportIpc,
} from "./adapters/support/support-ipc";

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const mockIpc = ipcMain as unknown as { _handlers: Map<string, (...args: unknown[]) => unknown> };
  const handler = mockIpc._handlers.get(channel);
  if (!handler) throw new Error(`Handler not found for channel: ${channel}`);
  return handler;
}

function createSupportService(): SupportService {
  return {
    listOutbox: vi.fn().mockReturnValue([]),
    retryOutbox: vi.fn().mockReturnValue({ success: true }),
    retrySale: vi.fn().mockReturnValue({ success: true }),
    resolveConflict: vi.fn().mockReturnValue({ success: true }),
    exportOutbox: vi.fn().mockReturnValue([]),
  } as unknown as SupportService;
}

describe("support-ipc busyTracker integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      unregisterSupportIpc();
    } catch {
      // already removed
    }
  });

  const mockRunProtectedOp = vi.fn(
    async (_kind: string, _label: string | undefined, fn: () => Promise<unknown>) => fn(),
  );
  const mockBusyTracker = {
    runProtectedOperation: mockRunProtectedOp,
  } as unknown as BusyTracker;

  it("RETRY_OUTBOX wraps with runProtectedOperation when busyTracker is provided", async () => {
    registerSupportIpc(createSupportService(), mockBusyTracker);
    const handler = getHandler(SUPPORT_CHANNELS.RETRY_OUTBOX);
    const result = await handler({}, "ob-1") as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockRunProtectedOp).toHaveBeenCalledWith("support", "Retry outbox entry", expect.any(Function));
  });

  it("RETRY_SALE wraps with runProtectedOperation when busyTracker is provided", async () => {
    registerSupportIpc(createSupportService(), mockBusyTracker);
    const handler = getHandler(SUPPORT_CHANNELS.RETRY_SALE);
    const result = await handler({}, "sale-retry-1") as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockRunProtectedOp).toHaveBeenCalledWith("support", "Retry sale outbox", expect.any(Function));
  });

  it("RESOLVE_CONFLICT wraps with runProtectedOperation when busyTracker is provided", async () => {
    registerSupportIpc(createSupportService(), mockBusyTracker);
    const handler = getHandler(SUPPORT_CHANNELS.RESOLVE_CONFLICT);
    const result = await handler({}, "ob-conflict", { resolution: "keep_local" }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockRunProtectedOp).toHaveBeenCalledWith("support", "Resolve conflict", expect.any(Function));
  });

  it("protected handlers work without busyTracker", async () => {
    registerSupportIpc(createSupportService());

    await expect(getHandler(SUPPORT_CHANNELS.RETRY_OUTBOX)({}, "ob-1")).resolves.toMatchObject({ success: true });
    await expect(getHandler(SUPPORT_CHANNELS.RETRY_SALE)({}, "sale-retry-2")).resolves.toMatchObject({ success: true });
    await expect(getHandler(SUPPORT_CHANNELS.RESOLVE_CONFLICT)({}, "ob-conflict", { resolution: "use_server" })).resolves.toMatchObject({ success: true });
  });
});
