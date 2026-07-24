// ---------------------------------------------------------------------------
// Application: Product use-case boundary
//
// Delegates to IProductsRepository. Contains no Electron or SQLite imports.
// Future Product business rules should land here behind repository ports.
// ---------------------------------------------------------------------------

import type { IProductsRepository } from "../../domain/products/products-repository";
import type {
  OfflineProductInput,
  OfflineProductResult,
  OfflineProductUpdateInput,
  ProductSearchFilters,
} from "../../domain/products/product";

export class ProductService {
  constructor(private readonly productsRepository: IProductsRepository) {}

  createProduct(input: OfflineProductInput): OfflineProductResult {
    return this.productsRepository.create(input);
  }

  updateProduct(productId: string, input: OfflineProductUpdateInput): OfflineProductResult {
    return this.productsRepository.update(productId, input);
  }

  deleteProduct(productId: string): OfflineProductResult {
    return this.productsRepository.delete(productId);
  }

  listProducts(filters?: ProductSearchFilters): OfflineProductResult[] {
    return filters?.search
      ? this.productsRepository.search(filters)
      : this.productsRepository.list();
  }

  getProduct(productId: string): OfflineProductResult {
    return this.productsRepository.get(productId);
  }

  findProductByCode(code: string): OfflineProductResult {
    return this.productsRepository.findByCode(code);
  }
}
