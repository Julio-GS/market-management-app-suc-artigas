import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusyTracker } from "./busy-state";
import type { PromotionService } from "./application/promotions/promotion-service";

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
  PROMOTIONS_CHANNELS,
  registerPromotionsIpc,
  unregisterPromotionsIpc,
} from "./adapters/promotions/promotions-ipc";

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const mockIpc = ipcMain as unknown as { _handlers: Map<string, (...args: unknown[]) => unknown> };
  const handler = mockIpc._handlers.get(channel);
  if (!handler) throw new Error(`Handler not found for channel: ${channel}`);
  return handler;
}

function createPromotionService(): PromotionService {
  return {
    createPromotion: vi.fn().mockReturnValue({ success: true }),
    updatePromotion: vi.fn().mockReturnValue({ success: true }),
    deletePromotion: vi.fn().mockReturnValue({ success: true }),
    listPromotions: vi.fn().mockReturnValue([]),
  } as unknown as PromotionService;
}

describe("promotions-ipc busyTracker integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      unregisterPromotionsIpc();
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
    registerPromotionsIpc(createPromotionService(), mockBusyTracker);
    const handler = getHandler(PROMOTIONS_CHANNELS.CREATE);
    const result = await handler({}, { name: "Summer Sale", type: "percentage" }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockRunProtectedOp).toHaveBeenCalledWith("write", "Create promotion", expect.any(Function));
  });

  it("UPDATE wraps with runProtectedOperation when busyTracker is provided", async () => {
    registerPromotionsIpc(createPromotionService(), mockBusyTracker);
    const handler = getHandler(PROMOTIONS_CHANNELS.UPDATE);
    const result = await handler({}, "promo-1", { name: "Updated Sale" }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockRunProtectedOp).toHaveBeenCalledWith("write", "Update promotion", expect.any(Function));
  });

  it("DELETE wraps with runProtectedOperation when busyTracker is provided", async () => {
    registerPromotionsIpc(createPromotionService(), mockBusyTracker);
    const handler = getHandler(PROMOTIONS_CHANNELS.DELETE);
    const result = await handler({}, "promo-to-del") as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockRunProtectedOp).toHaveBeenCalledWith("write", "Delete promotion", expect.any(Function));
  });

  it("write handlers work without busyTracker", async () => {
    registerPromotionsIpc(createPromotionService());

    await expect(getHandler(PROMOTIONS_CHANNELS.CREATE)({}, { name: "Summer Sale", type: "percentage" })).resolves.toMatchObject({ success: true });
    await expect(getHandler(PROMOTIONS_CHANNELS.UPDATE)({}, "promo-2", { name: "Updated Sale" })).resolves.toMatchObject({ success: true });
    await expect(getHandler(PROMOTIONS_CHANNELS.DELETE)({}, "promo-to-del2")).resolves.toMatchObject({ success: true });
  });
});
