// ---------------------------------------------------------------------------
// Application: PromotionService unit tests with mocked IPromotionsRepository
//
// Proves the thin service boundary without Electron or SQLite.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import type { IPromotionsRepository } from "../../domain/promotions/promotions-repository";
import type {
  OfflinePromotionInput,
  OfflinePromotionUpdateInput,
  OfflinePromotionResult,
} from "../../domain/promotions/promotion";
import { PromotionService } from "./promotion-service";

function mockRepo(): IPromotionsRepository {
  return {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  };
}

const makeInput = (): OfflinePromotionInput => ({
  name: "Test Promo",
  type: "percentage",
});

const makeUpdateInput = (): OfflinePromotionUpdateInput => ({
  name: "Updated Promo",
});

const makeResult = (overrides?: Partial<OfflinePromotionResult>): OfflinePromotionResult => ({
  success: true,
  promotion: {
    id: "p1",
    name: "Test",
    description: null,
    scope: "product",
    productId: null,
    type: "percentage",
    discountPercent: null,
    startDate: null,
    endDate: null,
    weekdays: null,
    enabled: true,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
  ...overrides,
});

describe("PromotionService", () => {
  describe("createPromotion", () => {
    it("delegates input unchanged to the repository", () => {
      const repo = mockRepo();
      const svc = new PromotionService(repo);
      const input = makeInput();
      const expected = makeResult();

      (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.createPromotion(input);
      expect(repo.create).toHaveBeenCalledWith(input);
      expect(result).toBe(expected);
    });
  });

  describe("updatePromotion", () => {
    it("delegates promotionId and input unchanged to the repository", () => {
      const repo = mockRepo();
      const svc = new PromotionService(repo);
      const input = makeUpdateInput();
      const expected = makeResult();

      (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.updatePromotion("p1", input);
      expect(repo.update).toHaveBeenCalledWith("p1", input);
      expect(result).toBe(expected);
    });
  });

  describe("deletePromotion", () => {
    it("delegates promotionId unchanged to the repository", () => {
      const repo = mockRepo();
      const svc = new PromotionService(repo);
      const expected = makeResult({ success: true, promotion: undefined });

      (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.deletePromotion("p1");
      expect(repo.delete).toHaveBeenCalledWith("p1");
      expect(result).toBe(expected);
    });
  });

  describe("listPromotions", () => {
    it("calls repository.list() and returns its result", () => {
      const repo = mockRepo();
      const svc = new PromotionService(repo);
      const expected = [makeResult()];

      (repo.list as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.listPromotions();
      expect(repo.list).toHaveBeenCalled();
      expect(result).toBe(expected);
    });
  });
});
