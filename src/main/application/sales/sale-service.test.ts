import { describe, expect, it, vi } from "vitest";
import type { ISalesRepository } from "../../domain/sales/sales-repository";
import type {
  ListedSale,
  OfflineSaleInput,
  OfflineSaleResult,
  SaleLookupResult,
} from "../../domain/sales/sale";

// We import the service class but it doesn't exist yet — RED phase
import { SaleService } from "./sale-service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockOfflineSaleResult(overrides?: Partial<OfflineSaleResult>): OfflineSaleResult {
  return {
    sale: {
      id: "sale-1",
      total: "200.00",
      customer: "Mostrador",
      invoiceStatus: "none",
      invoiceRequested: false,
      createdAt: "2026-07-01T00:00:00.000Z",
    },
    outboxId: "outbox-1",
    ...overrides,
  };
}

function mockSaleLookupResult(overrides?: Partial<SaleLookupResult>): SaleLookupResult {
  return {
    id: "sale-1",
    total: "200.00",
    customer: "Mostrador",
    invoiceStatus: "none",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function mockListedSales(): ListedSale[] {
  return [
    {
      id: "sale-1",
      total: "200.00",
      customer: "Mostrador",
      invoiceStatus: "none",
      invoiceRequested: false,
      createdAt: "2026-07-01T00:00:00.000Z",
      syncStatus: "pending",
    },
  ];
}

const validOfflineSale: OfflineSaleInput = {
  items: [
    {
      productId: "prod-1",
      name: "Test Product",
      quantity: 2,
      unitPrice: "100.00",
      subtotal: "200.00",
      discountAmount: "0.00",
    },
  ],
  payments: [{ method: "cash", amount: "200.00" }],
  invoiceRequested: false,
  total: "200.00",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SaleService", () => {
  describe("completeSale", () => {
    it("delegates to repository.completeSale with the same input", () => {
      const expectedResult = mockOfflineSaleResult();
      const mockRepo: ISalesRepository = {
        completeSale: vi.fn().mockReturnValue(expectedResult),
        getSaleById: vi.fn(),
        listSales: vi.fn(),
      };

      const service = new SaleService(mockRepo);
      const result = service.completeSale(validOfflineSale);

      expect(mockRepo.completeSale).toHaveBeenCalledTimes(1);
      expect(mockRepo.completeSale).toHaveBeenCalledWith(validOfflineSale);
      expect(result).toBe(expectedResult);
    });

    it("returns the exact same object identity from the repository", () => {
      const expectedResult = mockOfflineSaleResult();
      const mockRepo: ISalesRepository = {
        completeSale: vi.fn().mockReturnValue(expectedResult),
        getSaleById: vi.fn(),
        listSales: vi.fn(),
      };

      const service = new SaleService(mockRepo);
      const result = service.completeSale(validOfflineSale);
      expect(result).toBe(expectedResult);
    });
  });

  describe("getSale", () => {
    it("delegates to repository.getSaleById with the same saleId", () => {
      const expectedResult = mockSaleLookupResult();
      const mockRepo: ISalesRepository = {
        completeSale: vi.fn(),
        getSaleById: vi.fn().mockReturnValue(expectedResult),
        listSales: vi.fn(),
      };

      const service = new SaleService(mockRepo);
      const result = service.getSale("sale-1");

      expect(mockRepo.getSaleById).toHaveBeenCalledTimes(1);
      expect(mockRepo.getSaleById).toHaveBeenCalledWith("sale-1");
      expect(result).toBe(expectedResult);
    });

    it("returns undefined when repository returns undefined", () => {
      const mockRepo: ISalesRepository = {
        completeSale: vi.fn(),
        getSaleById: vi.fn().mockReturnValue(undefined),
        listSales: vi.fn(),
      };

      const service = new SaleService(mockRepo);
      const result = service.getSale("nonexistent");
      expect(result).toBeUndefined();
    });
  });

  describe("listSales", () => {
    it("delegates to repository.listSales with no arguments", () => {
      const expectedResult = mockListedSales();
      const mockRepo: ISalesRepository = {
        completeSale: vi.fn(),
        getSaleById: vi.fn(),
        listSales: vi.fn().mockReturnValue(expectedResult),
      };

      const service = new SaleService(mockRepo);
      const result = service.listSales();

      expect(mockRepo.listSales).toHaveBeenCalledTimes(1);
      expect(mockRepo.listSales).toHaveBeenCalledWith();
      expect(result).toBe(expectedResult);
    });

    it("returns empty array when repository returns empty", () => {
      const mockRepo: ISalesRepository = {
        completeSale: vi.fn(),
        getSaleById: vi.fn(),
        listSales: vi.fn().mockReturnValue([]),
      };

      const service = new SaleService(mockRepo);
      const result = service.listSales();
      expect(result).toEqual([]);
    });
  });

  it("contains no validation, auth, or SQLite logic", () => {
    // The service constructor only accepts ISalesRepository
    const mockRepo: ISalesRepository = {
      completeSale: vi.fn(),
      getSaleById: vi.fn(),
      listSales: vi.fn(),
    };
    const service = new SaleService(mockRepo);
    // It should be constructable with just a mock repo
    expect(service).toBeDefined();
    // It should not throw on any method call
    expect(() => service.completeSale(validOfflineSale)).not.toThrow();
    expect(() => service.getSale("any")).not.toThrow();
    expect(() => service.listSales()).not.toThrow();
  });
});
