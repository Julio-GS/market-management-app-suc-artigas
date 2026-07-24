// ---------------------------------------------------------------------------
// Application: Provider Purchase use-case boundary
//
// Delegates to IProviderPurchasesRepository. Contains no Electron or SQLite
// imports. Future Provider Purchase business rules should land here behind
// repository ports.
// ---------------------------------------------------------------------------

import type { IProviderPurchasesRepository } from "../../domain/provider-purchases/provider-purchases-repository";
import type {
  OfflineProviderPurchaseInput,
  OfflineProviderPurchaseResult,
  OfflineProviderPurchaseUpdateInput,
} from "../../domain/provider-purchases/provider-purchase";

export class ProviderPurchaseService {
  constructor(private readonly providerPurchasesRepository: IProviderPurchasesRepository) {}

  createProviderPurchase(input: OfflineProviderPurchaseInput): OfflineProviderPurchaseResult {
    return this.providerPurchasesRepository.create(input);
  }

  updateProviderPurchase(
    purchaseId: string,
    input: OfflineProviderPurchaseUpdateInput,
  ): OfflineProviderPurchaseResult {
    return this.providerPurchasesRepository.update(purchaseId, input);
  }

  deleteProviderPurchase(purchaseId: string): OfflineProviderPurchaseResult {
    return this.providerPurchasesRepository.delete(purchaseId);
  }

  listProviderPurchases(): OfflineProviderPurchaseResult[] {
    return this.providerPurchasesRepository.list();
  }
}
