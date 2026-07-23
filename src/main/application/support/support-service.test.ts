// ---------------------------------------------------------------------------
// Application: SupportService delegation tests
//
// Strict TDD RED phase: imports fail because SupportService and domain types
// do not exist yet. After GREEN implementation, these tests verify the
// service is a thin 1:1 delegation boundary with no extra logic.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---- RED: these imports will fail until domain + service are created ----
import { SupportService } from "./support-service";
import type { ISupportRepository } from "../../domain/support/support-repository";
import type {
  OutboxListItem,
  OutboxRetryResult,
  OutboxListFilter,
  ResolveConflictParams,
  RetryOutboxOptions,
} from "../../domain/support/support";

function mockRepo(): ISupportRepository {
  return {
    listOutbox: vi.fn(),
    retryOutbox: vi.fn(),
    retrySale: vi.fn(),
    resolveConflict: vi.fn(),
    exportOutbox: vi.fn(),
  };
}

describe("SupportService", () => {
  let repo: ISupportRepository;
  let svc: SupportService;

  beforeEach(() => {
    repo = mockRepo();
    svc = new SupportService(repo);
  });

  // -----------------------------------------------------------------------
  // listOutbox
  // -----------------------------------------------------------------------

  describe("listOutbox", () => {
    it("delegates to repository.listOutbox with the same filter and returns its result", () => {
      const filter: OutboxListFilter = { status: "failed" };
      const expected: OutboxListItem[] = [{ id: "ob-1" } as OutboxListItem];
      (repo.listOutbox as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.listOutbox(filter);

      expect(repo.listOutbox).toHaveBeenCalledExactlyOnceWith(filter);
      expect(result).toBe(expected);
    });

    it("delegates undefined filter to repository", () => {
      const expected: OutboxListItem[] = [];
      (repo.listOutbox as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.listOutbox();

      expect(repo.listOutbox).toHaveBeenCalledExactlyOnceWith(undefined);
      expect(result).toBe(expected);
    });
  });

  // -----------------------------------------------------------------------
  // retryOutbox
  // -----------------------------------------------------------------------

  describe("retryOutbox", () => {
    it("delegates to repository.retryOutbox with same id and opts", () => {
      const expected: OutboxRetryResult = { success: true };
      (repo.retryOutbox as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.retryOutbox("ob-1", { confirmManualFix: true });

      expect(repo.retryOutbox).toHaveBeenCalledExactlyOnceWith("ob-1", { confirmManualFix: true });
      expect(result).toBe(expected);
    });

    it("delegates without opts when undefined", () => {
      const expected: OutboxRetryResult = { success: false, error: "not found" };
      (repo.retryOutbox as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.retryOutbox("ob-2");

      expect(repo.retryOutbox).toHaveBeenCalledExactlyOnceWith("ob-2", undefined);
      expect(result).toBe(expected);
    });
  });

  // -----------------------------------------------------------------------
  // retrySale
  // -----------------------------------------------------------------------

  describe("retrySale", () => {
    it("delegates to repository.retrySale with same saleId", () => {
      const expected: OutboxRetryResult = { success: true, resetCount: 3 };
      (repo.retrySale as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.retrySale("sale-1");

      expect(repo.retrySale).toHaveBeenCalledExactlyOnceWith("sale-1");
      expect(result).toBe(expected);
    });
  });

  // -----------------------------------------------------------------------
  // resolveConflict
  // -----------------------------------------------------------------------

  describe("resolveConflict", () => {
    it("delegates to repository.resolveConflict with same id and params", () => {
      const params: ResolveConflictParams = { resolution: "keep_local" };
      const expected: OutboxRetryResult = { success: true };
      (repo.resolveConflict as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.resolveConflict("ob-1", params);

      expect(repo.resolveConflict).toHaveBeenCalledExactlyOnceWith("ob-1", params);
      expect(result).toBe(expected);
    });

    it("delegates use_server resolution", () => {
      const params: ResolveConflictParams = { resolution: "use_server" };
      const expected: OutboxRetryResult = { success: true };
      (repo.resolveConflict as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.resolveConflict("ob-bc", params);

      expect(repo.resolveConflict).toHaveBeenCalledExactlyOnceWith("ob-bc", params);
      expect(result).toBe(expected);
    });
  });

  // -----------------------------------------------------------------------
  // exportOutbox
  // -----------------------------------------------------------------------

  describe("exportOutbox", () => {
    it("delegates to repository.exportOutbox and returns its result", () => {
      const expected: OutboxListItem[] = [{ id: "ob-1" } as OutboxListItem];
      (repo.exportOutbox as ReturnType<typeof vi.fn>).mockReturnValue(expected);

      const result = svc.exportOutbox();

      expect(repo.exportOutbox).toHaveBeenCalledExactlyOnceWith();
      expect(result).toBe(expected);
    });
  });
});
