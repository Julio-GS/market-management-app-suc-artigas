// ---------------------------------------------------------------------------
// Application: Promotion use-case boundary
//
// Delegates to IPromotionsRepository. Contains no Electron or SQLite imports.
// Future Promotion business rules should land here behind repository ports.
// ---------------------------------------------------------------------------

import type { IPromotionsRepository } from "../../domain/promotions/promotions-repository";
import type {
  OfflinePromotionInput,
  OfflinePromotionResult,
  OfflinePromotionUpdateInput,
} from "../../domain/promotions/promotion";

export class PromotionService {
  constructor(private readonly promotionsRepository: IPromotionsRepository) {}

  createPromotion(input: OfflinePromotionInput): OfflinePromotionResult {
    return this.promotionsRepository.create(input);
  }

  updatePromotion(
    promotionId: string,
    input: OfflinePromotionUpdateInput,
  ): OfflinePromotionResult {
    return this.promotionsRepository.update(promotionId, input);
  }

  deletePromotion(promotionId: string): OfflinePromotionResult {
    return this.promotionsRepository.delete(promotionId);
  }

  listPromotions(): OfflinePromotionResult[] {
    return this.promotionsRepository.list();
  }
}
