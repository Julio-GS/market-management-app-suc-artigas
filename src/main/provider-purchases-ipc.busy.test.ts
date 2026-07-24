import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusyTracker } from "./busy-state";
import type { ProviderPurchaseService } from "./application/provider-purchases/provider-purchase-service";

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
  PROVIDER_PURCHASES_CHANNELS,
  registerProviderPurchasesIpc,
  unregisterProviderPurchasesIpc,
} from "./adapters/provider-purchases/provider-purchases-ipc";

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const mockIpc = ipcMain as unknown as { _handlers: Map<string, (...args: unknown[]) => unknown> };
  const handler = mockIpc._handlers.get(channel);
  if (!handler) throw new Error(`Handler not found for channel: ${channel}`);
  return handler;
}

function createProviderPurchaseService(): ProviderPurchaseService {
  return {
    createProviderPurchase: vi.fn().mockReturnValue({ success: true }),
    updateProviderPurchase: vi.fn().mockReturnValue({ success: true }),
    listProviderPurchases: vi.fn().mockReturnValue([]),
    deleteProviderPurchase: vi.fn().mockReturnValue({ success: true }),
  } as unknown as ProviderPurchaseService;
}

describe("provider-purchases-ipc busyTracker integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      unregisterProviderPurchasesIpc();
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

  it("CREATE wraps with runProtectedOperation when busyTracker is provided", async () => {
    registerProviderPurchasesIpc(createProviderPurchaseService(), mockBusyTracker);
    const handler = getHandler(PROVIDER_PURCHASES_CHANNELS.CREATE);
    const result = await handler({}, { provider_name: "Test Provider", amount: "1500.00" }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockRunProtectedOp).toHaveBeenCalledWith("write", "Create provider purchase", expect.any(Function));
  });

  it("UPDATE wraps with runProtectedOperation when busyTracker is provided", async () => {
    registerProviderPurchasesIpc(createProviderPurchaseService(), mockBusyTracker);
    const handler = getHandler(PROVIDER_PURCHASES_CHANNELS.UPDATE);
    const result = await handler({}, "pp-1", { provider_name: "Updated Provider" }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockRunProtectedOp).toHaveBeenCalledWith("write", "Update provider purchase", expect.any(Function));
  });

  it("DELETE wraps with runProtectedOperation when busyTracker is provided", async () => {
    registerProviderPurchasesIpc(createProviderPurchaseService(), mockBusyTracker);
    const handler = getHandler(PROVIDER_PURCHASES_CHANNELS.DELETE);
    const result = await handler({}, "pp-to-del") as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockRunProtectedOp).toHaveBeenCalledWith("write", "Delete provider purchase", expect.any(Function));
  });

  it("write handlers work without busyTracker", async () => {
    registerProviderPurchasesIpc(createProviderPurchaseService());

    await expect(getHandler(PROVIDER_PURCHASES_CHANNELS.CREATE)({}, { provider_name: "Test Provider", amount: "1500.00" })).resolves.toMatchObject({ success: true });
    await expect(getHandler(PROVIDER_PURCHASES_CHANNELS.UPDATE)({}, "pp-2", { provider_name: "Updated Provider" })).resolves.toMatchObject({ success: true });
    await expect(getHandler(PROVIDER_PURCHASES_CHANNELS.DELETE)({}, "pp-to-del2")).resolves.toMatchObject({ success: true });
  });
});
