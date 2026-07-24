// ---------------------------------------------------------------------------
// Application: ProviderPurchaseService unit tests with mocked
// IProviderPurchasesRepository.
//
// Proves the thin service boundary without Electron or SQLite.
// ---------------------------------------------------------------------------

import { describe, expect, it, vi } from "vitest";
import type { IProviderPurchasesRepository } from "../../domain/provider-purchases/provider-purchases-repository";
import type {
  OfflineProviderPurchaseInput,
  OfflineProviderPurchaseUpdateInput,
  OfflineProviderPurchaseResult,
} from "../../domain/provider-purchases/provider-purchase";
import { ProviderPurchaseService } from "./provider-purchase-service";

function mockRepo(): IProviderPurchasesRepository {
  return {
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    list: vi.fn(),
  };
}

const makeInput = (): OfflineProviderPurchaseInput => ({
  provider_name: "ACME Corp",
  amount: "1500.00",
});

const makeUpdateInput = (): OfflineProviderPurchaseUpdateInput => ({
  provider_name: "Updated Corp",
});

const makeResult = (overrides?: Partial<OfflineProviderPurchaseResult>): OfflineProviderPurchaseResult => ({
  success: true,
  purchase: {
    id: "pp-1",
    providerName: "Test",
    amount: "100.00",
    paymentMethod: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
  },
  ...overrides,
});

describe("ProviderPurchaseService", () => {
  describe("createProviderPurchase", () => {
    it("delegates input unchanged to the repository", () => {
      const repo = mockRepo();
      const svc = new ProviderPurchaseService(repo);
      const input = makeInput();
      const expected = makeResult();

      (repo.create as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.createProviderPurchase(input);
      expect(repo.create).toHaveBeenCalledWith(input);
      expect(result).toBe(expected);
    });
  });

  describe("updateProviderPurchase", () => {
    it("delegates purchaseId and input unchanged to the repository", () => {
      const repo = mockRepo();
      const svc = new ProviderPurchaseService(repo);
      const input = makeUpdateInput();
      const expected = makeResult();

      (repo.update as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.updateProviderPurchase("pp-1", input);
      expect(repo.update).toHaveBeenCalledWith("pp-1", input);
      expect(result).toBe(expected);
    });
  });

  describe("deleteProviderPurchase", () => {
    it("delegates purchaseId unchanged to the repository", () => {
      const repo = mockRepo();
      const svc = new ProviderPurchaseService(repo);
      const expected = makeResult({ success: true, purchase: undefined });

      (repo.delete as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.deleteProviderPurchase("pp-1");
      expect(repo.delete).toHaveBeenCalledWith("pp-1");
      expect(result).toBe(expected);
    });
  });

  describe("listProviderPurchases", () => {
    it("calls repository.list() and returns its result", () => {
      const repo = mockRepo();
      const svc = new ProviderPurchaseService(repo);
      const expected = [makeResult()];

      (repo.list as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.listProviderPurchases();
      expect(repo.list).toHaveBeenCalled();
      expect(result).toBe(expected);
    });
  });
});
