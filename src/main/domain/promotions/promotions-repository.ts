// ---------------------------------------------------------------------------
// Domain: Promotions repository port
//
// Defines the persistence contract for Promotion operations without a DB handle.
// Infrastructure adapters implement this port.
// ---------------------------------------------------------------------------

import type {
  OfflinePromotionInput,
  OfflinePromotionResult,
  OfflinePromotionUpdateInput,
} from "./promotion";

export interface IPromotionsRepository {
  create(input: OfflinePromotionInput): OfflinePromotionResult;
  update(promotionId: string, input: OfflinePromotionUpdateInput): OfflinePromotionResult;
  delete(promotionId: string): OfflinePromotionResult;
  list(): OfflinePromotionResult[];
}
