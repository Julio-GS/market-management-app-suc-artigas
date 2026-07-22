// ---------------------------------------------------------------------------
// Domain: Products repository port
//
// Defines the persistence contract for Product operations without a DB handle.
// Infrastructure adapters implement this port.
// ---------------------------------------------------------------------------

import type {
  OfflineProductInput,
  OfflineProductResult,
  OfflineProductUpdateInput,
  ProductSearchFilters,
} from "./product";

export interface IProductsRepository {
  create(input: OfflineProductInput): OfflineProductResult;
  update(productId: string, input: OfflineProductUpdateInput): OfflineProductResult;
  delete(productId: string): OfflineProductResult;
  list(): OfflineProductResult[];
  search(filters?: ProductSearchFilters): OfflineProductResult[];
  findByCode(code: string): OfflineProductResult;
  get(productId: string): OfflineProductResult;
}
