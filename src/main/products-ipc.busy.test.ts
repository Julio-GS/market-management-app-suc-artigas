import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusyTracker } from "./busy-state";
import type { ProductService } from "./application/products/product-service";

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
  PRODUCTS_CHANNELS,
  registerProductsIpc,
  unregisterProductsIpc,
} from "./adapters/products/products-ipc";

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const mockIpc = ipcMain as unknown as { _handlers: Map<string, (...args: unknown[]) => unknown> };
  const handler = mockIpc._handlers.get(channel);
  if (!handler) throw new Error(`Handler not found for channel: ${channel}`);
  return handler;
}

function createProductService(): ProductService {
  return {
    createProduct: vi.fn().mockReturnValue({ success: true, product: { detalle: "Test Product", codigos: [] } }),
    updateProduct: vi.fn().mockReturnValue({ success: true, product: { detalle: "Updated", codigos: [] } }),
    deleteProduct: vi.fn().mockReturnValue({ success: true }),
    listProducts: vi.fn().mockReturnValue([]),
    findProductByCode: vi.fn(),
    getProduct: vi.fn(),
  } as unknown as ProductService;
}

describe("products-ipc busyTracker integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      unregisterProductsIpc();
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
    registerProductsIpc(createProductService(), mockBusyTracker);
    const handler = getHandler(PRODUCTS_CHANNELS.CREATE);

    const result = await handler({}, { detalle: "Test Product", facturable: true }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockRunProtectedOp).toHaveBeenCalledWith("write", "Create product", expect.any(Function));
  });

  it("UPDATE wraps with runProtectedOperation when busyTracker is provided", async () => {
    registerProductsIpc(createProductService(), mockBusyTracker);
    const handler = getHandler(PRODUCTS_CHANNELS.UPDATE);

    const result = await handler({}, "prod-1", { detalle: "Updated", facturable: false }) as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockRunProtectedOp).toHaveBeenCalledWith("write", "Update product", expect.any(Function));
  });

  it("DELETE wraps with runProtectedOperation when busyTracker is provided", async () => {
    registerProductsIpc(createProductService(), mockBusyTracker);
    const handler = getHandler(PRODUCTS_CHANNELS.DELETE);

    const result = await handler({}, "prod-to-del") as { success: boolean };

    expect(result.success).toBe(true);
    expect(mockRunProtectedOp).toHaveBeenCalledWith("write", "Delete product", expect.any(Function));
  });

  it("validation failure still runs through the protected operation wrapper", async () => {
    registerProductsIpc(createProductService(), mockBusyTracker);
    const handler = getHandler(PRODUCTS_CHANNELS.CREATE);

    const result = await handler({}, { detalle: "" }) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("detalle");
    expect(mockRunProtectedOp).toHaveBeenCalled();
  });

  it("write handlers work without busyTracker", async () => {
    registerProductsIpc(createProductService());
    const createHandler = getHandler(PRODUCTS_CHANNELS.CREATE);
    const updateHandler = getHandler(PRODUCTS_CHANNELS.UPDATE);
    const deleteHandler = getHandler(PRODUCTS_CHANNELS.DELETE);

    await expect(createHandler({}, { detalle: "Test Product" })).resolves.toMatchObject({ success: true });
    await expect(updateHandler({}, "prod-2", { detalle: "Updated" })).resolves.toMatchObject({ success: true });
    await expect(deleteHandler({}, "prod-2")).resolves.toMatchObject({ success: true });
  });
});
