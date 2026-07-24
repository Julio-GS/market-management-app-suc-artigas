import { describe, expect, it, vi } from "vitest";
import type {
  IOfflineRepository,
} from "../../domain/offline/offline-repository";
import type {
  OfflineLoginIpcResult,
  OfflineLoginParams,
  OfflineSessionIpcResult,
  OfflineState,
} from "../../domain/offline/offline";

// These imports will fail (RED) until the production module exists.
import { OfflineService } from "./offline-service";

// ---------------------------------------------------------------------------
// Mock repository factory
// ---------------------------------------------------------------------------

function mockRepository(
  overrides?: Partial<IOfflineRepository>,
): IOfflineRepository {
  return {
    getState: vi.fn().mockReturnValue({
      ready: true,
      bootstrap: "complete",
      connectivity: "online",
      sync: "idle",
      pendingCount: 0,
      failureCount: 0,
      degraded: false,
      lastSyncAt: null,
      statusCounts: {
        pending: 0,
        in_flight: 0,
        failed: 0,
        retry_wait: 0,
        blocked_auth: 0,
        blocked_conflict: 0,
        manual_fix: 0,
        synced: 0,
      },
    } as OfflineState),
    getSession: vi.fn().mockReturnValue({
      user_id: "user-1",
      username: "cashier1",
      last_validated_at: "2026-07-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    } as OfflineSessionIpcResult),
    login: vi.fn().mockResolvedValue({
      success: true,
      userId: "user-1",
      username: "cashier1",
      token: "mock-token",
      offlineMode: false,
    } as OfflineLoginIpcResult),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Service delegation tests
// ---------------------------------------------------------------------------

describe("OfflineService", () => {
  describe("getState", () => {
    it("delegates to repository.getState()", () => {
      const repo = mockRepository();
      const service = new OfflineService(repo);

      const result = service.getState();

      expect(repo.getState).toHaveBeenCalledOnce();
      expect(result.ready).toBe(true);
      expect(result.bootstrap).toBe("complete");
    });

    it("returns the exact repository result without transformation", () => {
      const customState: OfflineState = {
        ready: false,
        bootstrap: "failed",
        connectivity: "offline",
        sync: "error",
        pendingCount: 3,
        failureCount: 1,
        degraded: true,
        lastSyncAt: null,
        statusCounts: {
          pending: 3,
          in_flight: 0,
          failed: 1,
          retry_wait: 0,
          blocked_auth: 0,
          blocked_conflict: 0,
          manual_fix: 0,
          synced: 0,
        },
      };
      const repo = mockRepository({ getState: vi.fn().mockReturnValue(customState) });
      const service = new OfflineService(repo);

      const result = service.getState();

      expect(result).toBe(customState);
    });
  });

  describe("getSession", () => {
    it("delegates to repository.getSession()", () => {
      const repo = mockRepository();
      const service = new OfflineService(repo);

      const result = service.getSession();

      expect(repo.getSession).toHaveBeenCalledOnce();
      expect(result).not.toBeNull();
      expect(result!.user_id).toBe("user-1");
    });

    it("returns null when repository returns null", () => {
      const repo = mockRepository({ getSession: vi.fn().mockReturnValue(null) });
      const service = new OfflineService(repo);

      const result = service.getSession();

      expect(result).toBeNull();
    });

    it("returns the exact repository result without transformation", () => {
      const customSession: OfflineSessionIpcResult = {
        user_id: "user-x",
        username: "test",
        last_validated_at: "2026-01-01T00:00:00.000Z",
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      };
      const repo = mockRepository({ getSession: vi.fn().mockReturnValue(customSession) });
      const service = new OfflineService(repo);

      const result = service.getSession();

      expect(result).toBe(customSession);
    });
  });

  describe("login", () => {
    it("delegates to repository.login()", async () => {
      const repo = mockRepository();
      const service = new OfflineService(repo);

      const params: OfflineLoginParams = {
        username: "admin",
        password: "test123",
        apiBaseUrl: "http://localhost:3000/api/v1",
      };

      const result = await service.login(params);

      expect(repo.login).toHaveBeenCalledOnce();
      expect(repo.login).toHaveBeenCalledWith(params);
      expect(result.success).toBe(true);
    });

    it("returns the exact repository result without transformation", async () => {
      const customResult: OfflineLoginIpcResult = {
        success: true,
        userId: "custom-id",
        username: "custom-user",
        token: "custom-token",
        offlineMode: true,
      };
      const repo = mockRepository({ login: vi.fn().mockResolvedValue(customResult) });
      const service = new OfflineService(repo);

      const result = await service.login({
        username: "admin",
        password: "test123",
        apiBaseUrl: "http://localhost:3000/api/v1",
      });

      expect(result).toBe(customResult);
    });

    it("returns error result from repository without transformation", async () => {
      const errorResult: OfflineLoginIpcResult = {
        success: false,
        error: "Invalid credentials",
      };
      const repo = mockRepository({ login: vi.fn().mockResolvedValue(errorResult) });
      const service = new OfflineService(repo);

      const result = await service.login({
        username: "admin",
        password: "wrong",
        apiBaseUrl: "http://localhost:3000/api/v1",
      });

      expect(result).toBe(errorResult);
    });
  });
});
