// ---------------------------------------------------------------------------
// BootstrapService tests
//
// Verifies pure delegation to the repository port with no transformation,
// validation, or side effects.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from "vitest";
import { BootstrapService } from "./bootstrap-service";
import type { IBootstrapRepository } from "../../domain/bootstrap/bootstrap-repository";
import type { BootstrapResult } from "../../domain/bootstrap/bootstrap";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockRepo(overrides?: Partial<IBootstrapRepository>): IBootstrapRepository {
  return {
    getStatus: vi.fn().mockReturnValue({
      status: "pending",
      ready: false,
      syncCursor: null,
    } as BootstrapResult),
    start: vi.fn().mockResolvedValue({
      status: "complete",
      ready: true,
      syncCursor: "cursor-1",
    } as BootstrapResult),
    resume: vi.fn().mockResolvedValue({
      status: "complete",
      ready: true,
      syncCursor: "cursor-2",
    } as BootstrapResult),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BootstrapService", () => {
  describe("getStatus", () => {
    it("delegates to the repository and returns the result unchanged", () => {
      const expected: BootstrapResult = {
        status: "pending",
        ready: false,
        syncCursor: null,
      };
      const mockRepo = makeMockRepo({
        getStatus: vi.fn().mockReturnValue(expected),
      });
      const service = new BootstrapService(mockRepo);

      const result = service.getStatus();

      expect(mockRepo.getStatus).toHaveBeenCalledOnce();
      expect(mockRepo.getStatus).toHaveBeenCalledWith();
      expect(result).toBe(expected);
    });

    it("returns a failed status without transformation when the repository returns failed", () => {
      const expected: BootstrapResult = {
        status: "failed",
        ready: false,
        syncCursor: null,
        error: "DB error",
      };
      const mockRepo = makeMockRepo({
        getStatus: vi.fn().mockReturnValue(expected),
      });
      const service = new BootstrapService(mockRepo);

      const result = service.getStatus();

      expect(result.status).toBe("failed");
      expect(result.ready).toBe(false);
      expect(result.error).toBe("DB error");
    });

    it("returns a complete status without transformation when the repository returns complete", () => {
      const expected: BootstrapResult = {
        status: "complete",
        ready: true,
        syncCursor: "cursor-abc",
      };
      const mockRepo = makeMockRepo({
        getStatus: vi.fn().mockReturnValue(expected),
      });
      const service = new BootstrapService(mockRepo);

      const result = service.getStatus();

      expect(result.status).toBe("complete");
      expect(result.ready).toBe(true);
      expect(result.syncCursor).toBe("cursor-abc");
    });

    it("does not perform any transformation or side effect", () => {
      const expected: BootstrapResult = {
        status: "in_progress",
        ready: false,
        syncCursor: null,
      };
      const mockRepo = makeMockRepo({
        getStatus: vi.fn().mockReturnValue(expected),
      });
      const service = new BootstrapService(mockRepo);

      const result = service.getStatus();

      // Exact identity — no transformation, no cloning
      expect(result).toBe(expected);
      // Only getStatus should have been called
      expect(mockRepo.getStatus).toHaveBeenCalledTimes(1);
      expect(mockRepo.start).not.toHaveBeenCalled();
      expect(mockRepo.resume).not.toHaveBeenCalled();
    });
  });

  describe("start", () => {
    it("delegates to the repository with the same arguments and returns the result unchanged", async () => {
      const expected: BootstrapResult = {
        status: "complete",
        ready: true,
        syncCursor: "cursor-1",
      };
      const mockRepo = makeMockRepo({
        start: vi.fn().mockResolvedValue(expected),
      });
      const service = new BootstrapService(mockRepo);

      const result = await service.start("token-1", "http://localhost:3000/api/v1");

      expect(mockRepo.start).toHaveBeenCalledOnce();
      expect(mockRepo.start).toHaveBeenCalledWith("token-1", "http://localhost:3000/api/v1");
      expect(result).toBe(expected);
    });

    it("returns a failed status when the repository returns failed", async () => {
      const expected: BootstrapResult = {
        status: "failed",
        ready: false,
        syncCursor: null,
        error: "Network error",
      };
      const mockRepo = makeMockRepo({
        start: vi.fn().mockResolvedValue(expected),
      });
      const service = new BootstrapService(mockRepo);

      const result = await service.start("token", "http://localhost:3000");

      expect(result.status).toBe("failed");
      expect(result.ready).toBe(false);
      expect(result.error).toBe("Network error");
    });

    it("does not catch errors thrown by the repository", async () => {
      const mockRepo = makeMockRepo({
        start: vi.fn().mockRejectedValue(new Error("DB crash")),
      });
      const service = new BootstrapService(mockRepo);

      await expect(service.start("token", "http://localhost:3000")).rejects.toThrow(
        "DB crash",
      );
    });
  });

  describe("resume", () => {
    it("delegates to the repository with the same arguments and returns the result unchanged", async () => {
      const expected: BootstrapResult = {
        status: "complete",
        ready: true,
        syncCursor: "cursor-2",
      };
      const mockRepo = makeMockRepo({
        resume: vi.fn().mockResolvedValue(expected),
      });
      const service = new BootstrapService(mockRepo);

      const result = await service.resume("token-2", "http://localhost:4000/api/v1");

      expect(mockRepo.resume).toHaveBeenCalledOnce();
      expect(mockRepo.resume).toHaveBeenCalledWith("token-2", "http://localhost:4000/api/v1");
      expect(result).toBe(expected);
    });

    it("does not catch errors thrown by the repository", async () => {
      const mockRepo = makeMockRepo({
        resume: vi.fn().mockRejectedValue(new Error("Unexpected")),
      });
      const service = new BootstrapService(mockRepo);

      await expect(service.resume("token", "http://localhost:3000")).rejects.toThrow(
        "Unexpected",
      );
    });
  });
});
