import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock Electron's ipcMain so IPC handler registration works in vitest
// ---------------------------------------------------------------------------

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
      // Expose for tests
      _handlers: handlers,
    },
  };
});

import {
  registerSalesIpc,
  unregisterSalesIpc,
  SALES_CHANNELS,
  validateSaleInput,
} from "./sales-ipc";
import type { SaleService } from "../../application/sales/sale-service";
import { FiscalBlockedError } from "../../domain/sales/sale";
import { OfflineAuthRequiredError } from "../../offline-auth";
import type { SalesSqliteRepository } from "../../infrastructure/persistence/sales-sqlite-repository";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSaleService() {
  return {
    completeSale: vi.fn(),
    listSales: vi.fn(),
  } as unknown as SaleService;
}

function createMockSalesRepository() {
  return {
    getDetailedSaleById: vi.fn(),
    listDetailedSales: vi.fn(),
  } as unknown as SalesSqliteRepository;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SALES_CHANNELS", () => {
  it("exposes byte-identical channel names", () => {
    expect(SALES_CHANNELS.COMPLETE_SALE).toBe("offline:sales:complete");
    expect(SALES_CHANNELS.GET_SALE).toBe("offline:sales:get");
    expect(SALES_CHANNELS.LIST_SALES).toBe("offline:sales:list");
  });
});

describe("registerSalesIpc / unregisterSalesIpc", () => {
  let mockService: SaleService;
  let mockSalesRepository: SalesSqliteRepository;

  beforeEach(() => {
    mockService = createMockSaleService();
    mockSalesRepository = createMockSalesRepository();
  });

  afterEach(() => {
    try {
      unregisterSalesIpc();
    } catch {
      // May already be unregistered
    }
    vi.clearAllMocks();
  });

  it("registerSalesIpc and unregisterSalesIpc are callable functions", () => {
    expect(registerSalesIpc).toBeTypeOf("function");
    expect(unregisterSalesIpc).toBeTypeOf("function");
  });

  it("registerSalesIpc succeeds with a valid service", () => {
    expect(() => registerSalesIpc(mockService, mockSalesRepository)).not.toThrow();
  });

  it("unregisterSalesIpc succeeds after registration", () => {
    registerSalesIpc(mockService, mockSalesRepository);
    expect(() => unregisterSalesIpc()).not.toThrow();
  });

  it("register -> unregister -> register cycle is safe", () => {
    registerSalesIpc(mockService, mockSalesRepository);
    unregisterSalesIpc();
    expect(() => registerSalesIpc(mockService, mockSalesRepository)).not.toThrow();
    unregisterSalesIpc();
  });

  it("registers IPC handlers on all three channels", async () => {
    const { ipcMain } = await import("electron");

    registerSalesIpc(mockService, mockSalesRepository);

    expect(ipcMain.handle).toHaveBeenCalledWith(
      "offline:sales:complete",
      expect.any(Function),
    );
    expect(ipcMain.handle).toHaveBeenCalledWith(
      "offline:sales:get",
      expect.any(Function),
    );
    expect(ipcMain.handle).toHaveBeenCalledWith(
      "offline:sales:list",
      expect.any(Function),
    );
  });

  it("unregisterSalesIpc removes all three IPC handlers", async () => {
    const { ipcMain } = await import("electron");

    registerSalesIpc(mockService, mockSalesRepository);
    unregisterSalesIpc();

    expect(ipcMain.removeHandler).toHaveBeenCalledWith("offline:sales:complete");
    expect(ipcMain.removeHandler).toHaveBeenCalledWith("offline:sales:get");
    expect(ipcMain.removeHandler).toHaveBeenCalledWith("offline:sales:list");
  });
});

describe("validateSaleInput", () => {
  it("accepts a valid minimal sale input", () => {
    const result = validateSaleInput({
      items: [
        {
          productId: "p1",
          name: "Test",
          quantity: 1,
          unitPrice: "10",
          subtotal: "10",
          discountAmount: "0",
        },
      ],
      payments: [{ method: "cash", amount: "10" }],
      total: "10.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.items).toHaveLength(1);
    }
  });

  it("rejects null / non-object input", () => {
    expect(validateSaleInput(null).valid).toBe(false);
    expect(validateSaleInput(undefined).valid).toBe(false);
    expect(validateSaleInput("string").valid).toBe(false);
    expect(validateSaleInput(42).valid).toBe(false);
  });

  it("rejects input with no items", () => {
    const result = validateSaleInput({
      items: [],
      payments: [{ method: "cash", amount: "10" }],
      total: "10.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("item");
  });

  it("rejects input with missing items array", () => {
    const result = validateSaleInput({
      payments: [{ method: "cash", amount: "10" }],
      total: "10.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects item with invalid productId (empty string)", () => {
    const result = validateSaleInput({
      items: [
        {
          productId: "",
          name: "X",
          quantity: 1,
          unitPrice: "1",
          subtotal: "1",
          discountAmount: "0",
        },
      ],
      payments: [{ method: "cash", amount: "1" }],
      total: "1.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects item with whitespace-only productId", () => {
    const result = validateSaleInput({
      items: [
        {
          productId: "   ",
          name: "X",
          quantity: 1,
          unitPrice: "1",
          subtotal: "1",
          discountAmount: "0",
        },
      ],
      payments: [{ method: "cash", amount: "1" }],
      total: "1.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects item with non-positive quantity", () => {
    const result = validateSaleInput({
      items: [
        {
          productId: "p1",
          name: "X",
          quantity: 0,
          unitPrice: "1",
          subtotal: "1",
          discountAmount: "0",
        },
      ],
      payments: [{ method: "cash", amount: "1" }],
      total: "1.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects item with negative quantity", () => {
    const result = validateSaleInput({
      items: [
        {
          productId: "p1",
          name: "X",
          quantity: -1,
          unitPrice: "1",
          subtotal: "1",
          discountAmount: "0",
        },
      ],
      payments: [{ method: "cash", amount: "1" }],
      total: "1.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects input with no payments", () => {
    const result = validateSaleInput({
      items: [
        {
          productId: "p1",
          name: "X",
          quantity: 1,
          unitPrice: "1",
          subtotal: "1",
          discountAmount: "0",
        },
      ],
      payments: [],
      total: "1.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.error).toContain("payment");
  });

  it("rejects payment with empty method", () => {
    const result = validateSaleInput({
      items: [
        {
          productId: "p1",
          name: "X",
          quantity: 1,
          unitPrice: "1",
          subtotal: "1",
          discountAmount: "0",
        },
      ],
      payments: [{ method: "", amount: "1" }],
      total: "1.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects payment with non-string amount", () => {
    const result = validateSaleInput({
      items: [
        {
          productId: "p1",
          name: "X",
          quantity: 1,
          unitPrice: "1",
          subtotal: "1",
          discountAmount: "0",
        },
      ],
      payments: [{ method: "cash", amount: 100 }],
      total: "1.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects missing total", () => {
    const result = validateSaleInput({
      items: [
        {
          productId: "p1",
          name: "X",
          quantity: 1,
          unitPrice: "1",
          subtotal: "1",
          discountAmount: "0",
        },
      ],
      payments: [{ method: "cash", amount: "1" }],
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects non-string total", () => {
    const result = validateSaleInput({
      items: [
        {
          productId: "p1",
          name: "X",
          quantity: 1,
          unitPrice: "1",
          subtotal: "1",
          discountAmount: "0",
        },
      ],
      payments: [{ method: "cash", amount: "1" }],
      total: 100,
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
  });

  it("rejects non-boolean invoiceRequested", () => {
    const result = validateSaleInput({
      items: [
        {
          productId: "p1",
          name: "X",
          quantity: 1,
          unitPrice: "1",
          subtotal: "1",
          discountAmount: "0",
        },
      ],
      payments: [{ method: "cash", amount: "1" }],
      total: "1.00",
      invoiceRequested: "yes" as unknown as boolean,
    });
    expect(result.valid).toBe(false);
  });

  it("produces exact error message for object check", () => {
    const result = validateSaleInput(null);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Sale input must be an object");
    }
  });

  it("produces exact error message for empty items", () => {
    const result = validateSaleInput({
      items: [],
      payments: [{ method: "cash", amount: "10" }],
      total: "10.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toBe("Sale input must contain at least one item");
    }
  });

  it("produces indexed error for item productId", () => {
    const result = validateSaleInput({
      items: [
        { productId: "", name: "X", quantity: 1, unitPrice: "1", subtotal: "1", discountAmount: "0" },
      ],
      payments: [{ method: "cash", amount: "1" }],
      total: "1.00",
      invoiceRequested: false,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain("Item 1");
      expect(result.error).toContain("productId");
    }
  });
});

describe("IPC complete handler", () => {
  let mockService: SaleService;
  let mockSalesRepository: SalesSqliteRepository;

  beforeEach(() => {
    mockService = createMockSaleService();
    mockSalesRepository = createMockSalesRepository();
  });

  afterEach(() => {
    try {
      unregisterSalesIpc();
    } catch {
      // ok
    }
    vi.clearAllMocks();
  });

  async function invokeComplete(input: unknown) {
    const { ipcMain } = await import("electron");
    registerSalesIpc(mockService, mockSalesRepository);

    const handler = ((ipcMain as unknown as { _handlers: Map<string, (...args: any[]) => any> })._handlers).get(
      "offline:sales:complete",
    );
    if (!handler) throw new Error("Handler not registered");
    return handler({} as Electron.IpcMainInvokeEvent, input);
  }

  it("validates input before calling service", async () => {
    const result = await invokeComplete(null);
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("INVALID_INPUT");
    expect(mockService.completeSale).not.toHaveBeenCalled();
  });

  it("returns success shape without top-level outboxId", async () => {
    const mockResult = {
      sale: {
        id: "sale-1",
        total: "200.00",
        customer: "Mostrador",
        invoiceStatus: "none",
        invoiceRequested: false,
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      outboxId: "outbox-1",
      warnings: ["Low stock warning"],
    };
    (mockService.completeSale as ReturnType<typeof vi.fn>).mockReturnValue(mockResult);
    (mockSalesRepository.getDetailedSaleById as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "sale-1",
      total: "200.00",
      customer: "Mostrador",
      invoiceStatus: "none",
      invoiceRequested: false,
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    const result = await invokeComplete({
      items: [{ productId: "p1", name: "X", quantity: 1, unitPrice: "10", subtotal: "10", discountAmount: "0" }],
      payments: [{ method: "cash", amount: "10" }],
      total: "10.00",
      invoiceRequested: false,
    });

    expect(result.success).toBe(true);
    expect(result.sale).toBeDefined();
    expect(result.sale.id).toBe("sale-1");
    expect((result as Record<string, unknown>).outboxId).toBeUndefined();
    expect(result.warnings).toEqual(["Low stock warning"]);
  });

  it("preserves runtime sale.invoiceRequested passthrough", async () => {
    const mockResult = {
      sale: {
        id: "sale-1",
        total: "200.00",
        customer: "Mostrador",
        invoiceStatus: "none",
        invoiceRequested: false,
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      outboxId: "outbox-1",
    };
    (mockService.completeSale as ReturnType<typeof vi.fn>).mockReturnValue(mockResult);
    (mockSalesRepository.getDetailedSaleById as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "sale-1",
      total: "200.00",
      customer: "Mostrador",
      invoiceStatus: "none",
      invoiceRequested: false,
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    const result = await invokeComplete({
      items: [{ productId: "p1", name: "X", quantity: 1, unitPrice: "10", subtotal: "10", discountAmount: "0" }],
      payments: [{ method: "cash", amount: "10" }],
      total: "10.00",
      invoiceRequested: false,
    });

    expect(result.success).toBe(true);
    expect(result.sale).toHaveProperty("invoiceRequested", false);
  });

  it("maps FiscalBlockedError to FISCAL_BLOCKED", async () => {
    (mockService.completeSale as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new FiscalBlockedError();
    });

    const result = await invokeComplete({
      items: [{ productId: "p1", name: "X", quantity: 1, unitPrice: "10", subtotal: "10", discountAmount: "0" }],
      payments: [{ method: "cash", amount: "10" }],
      total: "10.00",
      invoiceRequested: false,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("FISCAL_BLOCKED");
    expect(result.error).toBe(
      "Fiscal/invoice sales are not available offline. Please reconnect to complete this sale.",
    );
  });

  it("maps OfflineAuthRequiredError to OFFLINE_AUTH_REQUIRED", async () => {
    (mockService.completeSale as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new OfflineAuthRequiredError();
    });

    const result = await invokeComplete({
      items: [{ productId: "p1", name: "X", quantity: 1, unitPrice: "10", subtotal: "10", discountAmount: "0" }],
      payments: [{ method: "cash", amount: "10" }],
      total: "10.00",
      invoiceRequested: false,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("OFFLINE_AUTH_REQUIRED");
    expect(result.error).toBe(
      "Offline operations require a previously authenticated session. Please log in while online first.",
    );
  });

  it("maps SALE_ERROR for generic errors", async () => {
    (mockService.completeSale as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("Database connection lost");
    });

    const result = await invokeComplete({
      items: [{ productId: "p1", name: "X", quantity: 1, unitPrice: "10", subtotal: "10", discountAmount: "0" }],
      payments: [{ method: "cash", amount: "10" }],
      total: "10.00",
      invoiceRequested: false,
    });

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("SALE_ERROR");
    expect(result.error).toBe("Database connection lost");
  });

  it("falls back to 'Sale failed' for non-Error throws", async () => {
    (mockService.completeSale as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw "something weird";
    });

    const result = await invokeComplete({
      items: [{ productId: "p1", name: "X", quantity: 1, unitPrice: "10", subtotal: "10", discountAmount: "0" }],
      payments: [{ method: "cash", amount: "10" }],
      total: "10.00",
      invoiceRequested: false,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("Sale failed");
    expect(result.errorCode).toBe("SALE_ERROR");
  });
});

describe("IPC get handler", () => {
  let mockService: SaleService;
  let mockSalesRepository: SalesSqliteRepository;

  beforeEach(() => {
    mockService = createMockSaleService();
    mockSalesRepository = createMockSalesRepository();
  });

  afterEach(() => {
    try {
      unregisterSalesIpc();
    } catch {
      // ok
    }
    vi.clearAllMocks();
  });

  async function invokeGet(saleId: string) {
    const { ipcMain } = await import("electron");
    registerSalesIpc(mockService, mockSalesRepository);

    const handler = ((ipcMain as unknown as { _handlers: Map<string, (...args: any[]) => any> })._handlers).get(
      "offline:sales:get",
    );
    if (!handler) throw new Error("Handler not registered");
    return handler({} as Electron.IpcMainInvokeEvent, saleId);
  }

  it("returns success with sale when found", async () => {
    (mockSalesRepository.getDetailedSaleById as ReturnType<typeof vi.fn>).mockReturnValue({
      id: "sale-1",
      total: "200.00",
      customer: "Mostrador",
      invoiceStatus: "none",
      createdAt: "2026-07-01T00:00:00.000Z",
    });

    const result = await invokeGet("sale-1");
    expect(result.success).toBe(true);
    expect(result.sale).toBeDefined();
    expect(result.sale.id).toBe("sale-1");
  });

  it("returns NOT_FOUND when sale does not exist", async () => {
    (mockSalesRepository.getDetailedSaleById as ReturnType<typeof vi.fn>).mockReturnValue(undefined);

    const result = await invokeGet("nonexistent");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Sale not found");
    expect(result.errorCode).toBe("NOT_FOUND");
  });

  it("returns SALE_ERROR on unexpected failure", async () => {
    (mockSalesRepository.getDetailedSaleById as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("DB error");
    });

    const result = await invokeGet("sale-1");
    expect(result.success).toBe(false);
    expect(result.errorCode).toBe("SALE_ERROR");
  });

  it("falls back to 'Failed to retrieve sale' for non-Error throws", async () => {
    (mockSalesRepository.getDetailedSaleById as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw "weird";
    });

    const result = await invokeGet("sale-1");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Failed to retrieve sale");
  });
});

describe("IPC list handler", () => {
  let mockService: SaleService;
  let mockSalesRepository: SalesSqliteRepository;

  beforeEach(() => {
    mockService = createMockSaleService();
    mockSalesRepository = createMockSalesRepository();
  });

  afterEach(() => {
    try {
      unregisterSalesIpc();
    } catch {
      // ok
    }
    vi.clearAllMocks();
  });

  async function invokeList() {
    const { ipcMain } = await import("electron");
    registerSalesIpc(mockService, mockSalesRepository);

    const handler = ((ipcMain as unknown as { _handlers: Map<string, (...args: any[]) => any> })._handlers).get(
      "offline:sales:list",
    );
    if (!handler) throw new Error("Handler not registered");
    return handler();
  }

  it("returns ListedSale[] on success", async () => {
    (mockService.listSales as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: "sale-1",
        total: "200.00",
        customer: "Mostrador",
        invoiceStatus: "none",
        invoiceRequested: false,
        createdAt: "2026-07-01T00:00:00.000Z",
        syncStatus: "pending",
      },
    ]);
    (mockSalesRepository.listDetailedSales as ReturnType<typeof vi.fn>).mockReturnValue([
      {
        id: "sale-1",
        total: "200.00",
        customer: "Mostrador",
        invoiceStatus: "none",
        invoiceRequested: false,
        createdAt: "2026-07-01T00:00:00.000Z",
      },
    ]);

    const result = await invokeList();
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("sale-1");
    expect(result[0].syncStatus).toBe("pending");
  });

  it("returns empty array on handler failure", async () => {
    (mockService.listSales as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("DB error");
    });

    const result = await invokeList();
    expect(result).toEqual([]);
  });
});
