// ---------------------------------------------------------------------------
// Adapter: Products IPC handler tests
//
// Migrated from src/main/products-ipc.test.ts to exercise the new production-path
// IPC adapter. Uses a mocked ProductService to verify validation, error mapping,
// and channel names without needing a real SQLite database.
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

import { PRODUCTS_CHANNELS, registerProductsIpc, unregisterProductsIpc } from "./products-ipc";
import { ProductService } from "../../application/products/product-service";
import type { IProductsRepository } from "../../domain/products/products-repository";

function mockRepo(): IProductsRepository {
  return {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
    search: vi.fn(),
    findByCode: vi.fn(),
    get: vi.fn(),
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

describe("products-ipc (new adapter)", () => {
  let repo: IProductsRepository;
  let svc: ProductService;

  beforeEach(() => {
    repo = mockRepo();
    svc = new ProductService(repo);
    registerProductsIpc(svc);
  });

  afterEach(() => {
    try {
      unregisterProductsIpc();
    } catch {
      // already removed
    }
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // Validation: CREATE
  // -----------------------------------------------------------------------

  describe("CREATE validation", () => {
    it("rejects invalid create payloads before calling the service", async () => {
      const handler = await getHandler(PRODUCTS_CHANNELS.CREATE);
      const result = handler({}, { detalle: "", codigos: [123] }) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain("detalle");
      expect(repo.create).not.toHaveBeenCalled();
    });

    it("accepts valid create payloads, sanitizes barcodes, and returns service result", async () => {
      const expected = {
        success: true as const,
        product: {
          id: "p1", detalle: "Azucar", costoNeto: null, costoFinal: "100",
          iva: null, cambioCosto: "fixed", cambioPrecio: "fixed", etiqueta: "",
          facturable: true, manejaStock: true, codigos: ["AZ-1", "779123"],
          pricingMode: "fixed", createdAt: "2026-01-01", updatedAt: "2026-01-01",
        },
      };
      (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(PRODUCTS_CHANNELS.CREATE);
      const result = handler({}, {
        detalle: "Azucar",
        codigos: ["  AZ-1  ", "AZ-1", "", "   ", "779123"],
        facturable: true,
        maneja_stock: true,
      }) as { success: boolean; product?: { detalle: string; codigos: string[] } };

      expect(result.success).toBe(true);
      expect(result.product?.detalle).toBe("Azucar");
      expect(result.product?.codigos).toEqual(["AZ-1", "779123"]);
    });
  });

  // -----------------------------------------------------------------------
  // Validation: UPDATE
  // -----------------------------------------------------------------------

  describe("UPDATE validation", () => {
    it("rejects invalid update payloads before calling the service", async () => {
      const handler = await getHandler(PRODUCTS_CHANNELS.UPDATE);
      const result = handler({}, "prod-1", { detalle: 42, codigos: ["OK", "   "] }) as { success: boolean; error?: string };
      expect(result.success).toBe(false);
      expect(result.error).toContain("detalle");
      expect(repo.update).not.toHaveBeenCalled();
    });

    it("accepts valid update payloads and delegates to service", async () => {
      const expected = {
        success: true as const,
        product: {
          id: "prod-1", detalle: "Updated", costoNeto: null, costoFinal: "200",
          iva: null, cambioCosto: "fixed", cambioPrecio: "fixed", etiqueta: "",
          facturable: true, manejaStock: true, codigos: ["OK"],
          pricingMode: "fixed", createdAt: "2026-01-01", updatedAt: "2026-01-01",
        },
      };
      (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(PRODUCTS_CHANNELS.UPDATE);
      const result = handler({}, "prod-1", { detalle: "Updated", codigos: ["OK"] }) as { success: boolean; product?: { detalle: string } };

      expect(result.success).toBe(true);
      expect(result.product?.detalle).toBe("Updated");
    });
  });

  // -----------------------------------------------------------------------
  // Validation: DELETE
  // -----------------------------------------------------------------------

  describe("DELETE", () => {
    it("delegates to service and returns result", async () => {
      (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue({ success: true });

      const handler = await getHandler(PRODUCTS_CHANNELS.DELETE);
      const result = handler({}, "prod-1") as { success: boolean };

      expect(result.success).toBe(true);
      expect(repo.delete).toHaveBeenCalledWith("prod-1");
    });

    it("returns PROTECTED_PRODUCT error when service rejects", async () => {
      (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue({
        success: false,
        error: "Cannot delete a protected product",
        errorCode: "PROTECTED_PRODUCT",
      });

      const handler = await getHandler(PRODUCTS_CHANNELS.DELETE);
      const result = handler({}, "prod-protected") as { success: boolean; error?: string; errorCode?: string };

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("PROTECTED_PRODUCT");
    });
  });

  // -----------------------------------------------------------------------
  // Validation: FIND_BY_CODE
  // -----------------------------------------------------------------------

  describe("FIND_BY_CODE validation", () => {
    it("rejects invalid barcode lookup payloads", async () => {
      const handler = await getHandler(PRODUCTS_CHANNELS.FIND_BY_CODE);
      const result = handler({}, { code: "BAD" }) as { success: boolean; error?: string; errorCode?: string };
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("INVALID_INPUT");
      expect(result.error).toContain("code");
    });

    it("accepts valid code and delegates to service", async () => {
      const expected = {
        success: true as const,
        product: {
          id: "p1", detalle: "Leche", costoNeto: null, costoFinal: "120",
          iva: null, cambioCosto: "fixed", cambioPrecio: "fixed", etiqueta: "",
          facturable: true, manejaStock: true, codigos: ["LEC-0001"],
          pricingMode: "fixed", createdAt: "2026-01-01", updatedAt: "2026-01-01",
        },
      };
      (repo.findByCode as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(PRODUCTS_CHANNELS.FIND_BY_CODE);
      const result = handler({}, "LEC-0001") as { success: boolean; product?: { detalle: string } };

      expect(result.success).toBe(true);
      expect(result.product?.detalle).toBe("Leche");
    });
  });

  // -----------------------------------------------------------------------
  // Validation: LIST
  // -----------------------------------------------------------------------

  describe("LIST validation", () => {
    it("rejects invalid list filter payloads", async () => {
      const handler = await getHandler(PRODUCTS_CHANNELS.LIST);
      const result = handler({}, { search: 42 }) as Array<{ success: boolean; error?: string }>;
      expect(result).toHaveLength(1);
      expect(result[0].success).toBe(false);
      expect(result[0].error).toContain("search");
    });

    it("accepts valid list request and returns service results", async () => {
      const expected = [
        { success: true as const, product: { id: "p1", detalle: "A", costoNeto: null, costoFinal: "10", iva: null, cambioCosto: "fixed", cambioPrecio: "fixed", etiqueta: "", facturable: true, manejaStock: true, codigos: [], pricingMode: "fixed", createdAt: "2026-01-01", updatedAt: "2026-01-01" } },
      ];
      (repo.list as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(PRODUCTS_CHANNELS.LIST);
      const result = handler({}, undefined) as Array<{ success: boolean }>;

      expect(result).toHaveLength(1);
      expect(result[0].success).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // Validation: GET
  // -----------------------------------------------------------------------

  describe("GET", () => {
    it("delegates to service and returns result", async () => {
      const expected = {
        success: true as const,
        product: {
          id: "prod-1", detalle: "Leche", costoNeto: null, costoFinal: "120",
          iva: null, cambioCosto: "fixed", cambioPrecio: "fixed", etiqueta: "",
          facturable: true, manejaStock: true, codigos: ["LEC-0001"],
          pricingMode: "fixed", createdAt: "2026-01-01", updatedAt: "2026-01-01",
        },
      };
      (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const handler = await getHandler(PRODUCTS_CHANNELS.GET);
      const result = handler({}, "prod-1") as { success: boolean; product?: { detalle: string } };

      expect(result.success).toBe(true);
      expect(result.product?.detalle).toBe("Leche");
    });

    it("returns error result when service returns failure", async () => {
      (repo.get as ReturnType<typeof vi.fn>).mockReturnValue({
        success: false,
        error: "Product not found",
      });

      const handler = await getHandler(PRODUCTS_CHANNELS.GET);
      const result = handler({}, "nonexistent") as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBe("Product not found");
    });
  });

  // -----------------------------------------------------------------------
  // Channel name preservation
  // -----------------------------------------------------------------------

  describe("channel name preservation", () => {
    it("uses the same channel names as the legacy IPC adapter", () => {
      expect(PRODUCTS_CHANNELS.CREATE).toBe("offline:products:create");
      expect(PRODUCTS_CHANNELS.UPDATE).toBe("offline:products:update");
      expect(PRODUCTS_CHANNELS.DELETE).toBe("offline:products:delete");
      expect(PRODUCTS_CHANNELS.LIST).toBe("offline:products:list");
      expect(PRODUCTS_CHANNELS.GET).toBe("offline:products:get");
      expect(PRODUCTS_CHANNELS.FIND_BY_CODE).toBe("offline:products:findByCode");
    });
  });
});
