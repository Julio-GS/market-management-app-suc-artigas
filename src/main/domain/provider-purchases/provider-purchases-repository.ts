// ---------------------------------------------------------------------------
// Domain: Provider Purchases repository port
//
// Defines the persistence contract for Provider Purchase operations without a
// DB handle. Infrastructure adapters implement this port.
// ---------------------------------------------------------------------------

import type {
  OfflineProviderPurchaseInput,
  OfflineProviderPurchaseResult,
  OfflineProviderPurchaseUpdateInput,
} from "./provider-purchase";

export interface IProviderPurchasesRepository {
  create(input: OfflineProviderPurchaseInput): OfflineProviderPurchaseResult;
  update(
    purchaseId: string,
    input: OfflineProviderPurchaseUpdateInput,
  ): OfflineProviderPurchaseResult;
  delete(purchaseId: string): OfflineProviderPurchaseResult;
  list(): OfflineProviderPurchaseResult[];
}
