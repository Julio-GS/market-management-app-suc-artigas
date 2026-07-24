// ---------------------------------------------------------------------------
// Application: ProductService unit tests with mocked IProductsRepository
//
// Proves the thin service boundary without Electron or SQLite.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import type { IProductsRepository } from "../../domain/products/products-repository";
import type {
  OfflineProductInput,
  OfflineProductUpdateInput,
  OfflineProductResult,
  ProductSearchFilters,
} from "../../domain/products/product";
import { ProductService } from "./product-service";

function mockRepo(): IProductsRepository {
  return {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    list: vi.fn<() => OfflineProductResult[]>(),
    search: vi.fn<(filters?: ProductSearchFilters) => OfflineProductResult[]>(),
    findByCode: vi.fn<(code: string) => OfflineProductResult>(),
    get: vi.fn<(id: string) => OfflineProductResult>(),
  };
}

const makeInput = (): OfflineProductInput => ({
  detalle: "Test Product",
  codigos: ["CODE-1"],
});

const makeUpdateInput = (): OfflineProductUpdateInput => ({
  detalle: "Updated",
});

const makeResult = (overrides?: Partial<OfflineProductResult>): OfflineProductResult => ({
  success: true,
  product: {
    id: "p1",
    detalle: "Test",
    costoNeto: null,
    costoFinal: "100",
    iva: null,
    cambioCosto: "fixed",
    cambioPrecio: "fixed",
    etiqueta: "",
    facturable: true,
    manejaStock: true,
    codigos: ["CODE-1"],
    pricingMode: "fixed",
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
  ...overrides,
});

describe("ProductService", () => {
  describe("createProduct", () => {
    it("delegates input unchanged to the repository", () => {
      const repo = mockRepo();
      const svc = new ProductService(repo);
      const input = makeInput();
      const expected = makeResult();

      (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.createProduct(input);
      expect(repo.create).toHaveBeenCalledWith(input);
      expect(result).toBe(expected);
    });
  });

  describe("updateProduct", () => {
    it("delegates productId and input unchanged to the repository", () => {
      const repo = mockRepo();
      const svc = new ProductService(repo);
      const input = makeUpdateInput();
      const expected = makeResult();

      (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.updateProduct("p1", input);
      expect(repo.update).toHaveBeenCalledWith("p1", input);
      expect(result).toBe(expected);
    });
  });

  describe("deleteProduct", () => {
    it("delegates productId unchanged to the repository", () => {
      const repo = mockRepo();
      const svc = new ProductService(repo);
      const expected = makeResult({ success: true, product: undefined });

      (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.deleteProduct("p1");
      expect(repo.delete).toHaveBeenCalledWith("p1");
      expect(result).toBe(expected);
    });
  });

  describe("listProducts", () => {
    it("calls repository.list() when no search term is provided", () => {
      const repo = mockRepo();
      const svc = new ProductService(repo);
      const expected = [makeResult()];

      (repo.list as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.listProducts();
      expect(repo.list).toHaveBeenCalled();
      expect(repo.search).not.toHaveBeenCalled();
      expect(result).toBe(expected);
    });

    it("calls repository.list() when filters is undefined", () => {
      const repo = mockRepo();
      const svc = new ProductService(repo);
      const expected = [makeResult()];

      (repo.list as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.listProducts(undefined);
      expect(repo.list).toHaveBeenCalled();
      expect(result).toBe(expected);
    });

    it("calls repository.list() when search is empty string", () => {
      const repo = mockRepo();
      const svc = new ProductService(repo);
      const expected = [makeResult()];

      (repo.list as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.listProducts({ search: "" });
      expect(repo.list).toHaveBeenCalled();
      expect(result).toBe(expected);
    });

    it("calls repository.search() when search term is truthy", () => {
      const repo = mockRepo();
      const svc = new ProductService(repo);
      const filters = { search: "leche" };
      const expected = [makeResult()];

      (repo.search as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.listProducts(filters);
      expect(repo.search).toHaveBeenCalledWith(filters);
      expect(repo.list).not.toHaveBeenCalled();
      expect(result).toBe(expected);
    });
  });

  describe("getProduct", () => {
    it("delegates productId unchanged to the repository", () => {
      const repo = mockRepo();
      const svc = new ProductService(repo);
      const expected = makeResult();

      (repo.get as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.getProduct("p1");
      expect(repo.get).toHaveBeenCalledWith("p1");
      expect(result).toBe(expected);
    });
  });

  describe("findProductByCode", () => {
    it("delegates code unchanged to the repository", () => {
      const repo = mockRepo();
      const svc = new ProductService(repo);
      const expected = makeResult();

      (repo.findByCode as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.findProductByCode("CODE-1");
      expect(repo.findByCode).toHaveBeenCalledWith("CODE-1");
      expect(result).toBe(expected);
    });
  });
});
