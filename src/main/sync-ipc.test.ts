import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock pull-reconciliation module so we can verify it is NOT called when push is blocked
// ---------------------------------------------------------------------------

const { mockPullAndApply, mockReplayOutbox } = vi.hoisted(() => ({
  mockPullAndApply: vi.fn(),
  mockReplayOutbox: vi.fn(),
}));

vi.mock("./pull-reconciliation", () => ({
  pullAndApply: mockPullAndApply,
}));

// Mock sync-engine module for pull-gate tests
vi.mock("./sync-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sync-engine")>();
  return {
    ...actual,
    replayOutbox: mockReplayOutbox,
  };
});

// ---------------------------------------------------------------------------
// Mock Electron's ipcMain so IPC handler registration works in vitest
// ---------------------------------------------------------------------------

vi.mock("electron", () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
      _handlers: handlers,
    },
  };
});

import { ipcMain } from "electron";
import {
  SYNC_CHANNELS,
  registerSyncIpc,
  unregisterSyncIpc,
  createBackendPushFn,
} from "./sync-ipc";
import type { OutboxEntryRow } from "./sync-engine";

// Helper to extract a typed handler from the mocked IPC
function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const mockIpc = ipcMain as unknown as {
    _handlers: Map<string, (...args: unknown[]) => unknown>;
  };
  const handler = mockIpc._handlers.get(channel);
  if (!handler) throw new Error(`Handler not found for channel: ${channel}`);
  return handler as (...args: unknown[]) => Promise<unknown>;
}

describe("sync-ipc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      unregisterSyncIpc();
    } catch {
      // already removed
    }
  });

  // -----------------------------------------------------------------------
  // Registration lifecycle
  // -----------------------------------------------------------------------

  describe("registration", () => {
    it("registers handlers that can be removed cleanly", () => {
      const getDb = vi.fn();

      registerSyncIpc(getDb);
      unregisterSyncIpc();

      // Second unregister should not throw
      expect(() => unregisterSyncIpc()).not.toThrow();
    });

    it("does not throw when unregistering without prior registration", () => {
      expect(() => unregisterSyncIpc()).not.toThrow();
    });
  });

  // -----------------------------------------------------------------------
  // Channel constants
  // -----------------------------------------------------------------------

  describe("channel constants", () => {
    it("exports the expected channel names including PULL", () => {
      expect(SYNC_CHANNELS.START_SYNC).toBe("sync:start");
      expect(SYNC_CHANNELS.GET_SYNC_STATE).toBe("sync:get-state");
      expect(SYNC_CHANNELS.PULL).toBe("sync:pull");
    });
  });

  // -----------------------------------------------------------------------
  // Handler behavior — degraded state when DB is unavailable
  // -----------------------------------------------------------------------

  describe("sync:get-state handler (degraded)", () => {
    it("returns a degraded/empty state when DB is unavailable", async () => {
      const getDb = vi.fn().mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      registerSyncIpc(getDb);

      const handler = getHandler(SYNC_CHANNELS.GET_SYNC_STATE);

      const result = handler();

      expect(result).toBeDefined();
      expect(result).toHaveProperty("pendingCount");
      expect(result).toHaveProperty("failedCount");
      expect(result).toHaveProperty("revalidationRequired");
      expect(result).toHaveProperty("lastSyncAt");
    });
  });

  // -----------------------------------------------------------------------
  // Handler behavior — sync:start
  // -----------------------------------------------------------------------

  describe("sync:start handler", () => {
    it("returns a stub result with synced/failed/blocked fields", async () => {
      const getDb = vi.fn().mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      registerSyncIpc(getDb);

      const handler = getHandler(SYNC_CHANNELS.START_SYNC);
      const result = (await handler()) as Record<string, unknown>;

      expect(result).toBeDefined();
      expect(result).toHaveProperty("synced");
      expect(result).toHaveProperty("failed");
      expect(result).toHaveProperty("blocked");
      expect(result).toHaveProperty("revalidationBlocked");
    });

    it("accepts optional auth params and passes them through", async () => {
      const getDb = vi.fn().mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      registerSyncIpc(getDb);

      const handler = getHandler(SYNC_CHANNELS.START_SYNC);
      const result = (await handler(
        {},
        { apiBaseUrl: "http://localhost:3000/api/v1", token: "test-token" },
      )) as Record<string, unknown>;

      expect(result).toBeDefined();
      expect(result).toHaveProperty("synced");
    });

    // GAP 5: pull gate — verify pullAndApply is NOT called when replay is blocked
    it("does NOT call pullAndApply when replayOutbox returns revalidationBlocked", async () => {
      mockReplayOutbox.mockResolvedValue({
        synced: 0,
        failed: 0,
        blocked: 0,
        skipped: 0,
        revalidationBlocked: true,
      });
      mockPullAndApply.mockClear();

      const getDb = vi.fn().mockReturnValue({});
      registerSyncIpc(getDb);

      const handler = getHandler(SYNC_CHANNELS.START_SYNC);
      const result = (await handler(
        {},
        { apiBaseUrl: "http://localhost:3000/api/v1", token: "test-token" },
      )) as { revalidationBlocked: boolean };

      expect(result.revalidationBlocked).toBe(true);
      // pullAndApply must NOT have been called
      expect(mockPullAndApply).not.toHaveBeenCalled();
    });

    it("does NOT call pullAndApply when replayOutbox has blocked entries", async () => {
      mockReplayOutbox.mockResolvedValue({
        synced: 3,
        failed: 1,
        blocked: 2,
        skipped: 0,
        revalidationBlocked: false,
      });
      mockPullAndApply.mockClear();

      const getDb = vi.fn().mockReturnValue({});
      registerSyncIpc(getDb);

      const handler = getHandler(SYNC_CHANNELS.START_SYNC);
      const result = (await handler(
        {},
        { apiBaseUrl: "http://localhost:3000/api/v1", token: "test-token" },
      )) as { blocked: number };

      expect(result.blocked).toBe(2);
      // pullAndApply must NOT have been called when blocked > 0
      expect(mockPullAndApply).not.toHaveBeenCalled();
    });

    it("calls pullAndApply when replayOutbox is clean (no blocks, no revalidationBlocked)", async () => {
      mockReplayOutbox.mockResolvedValue({
        synced: 5,
        failed: 0,
        blocked: 0,
        skipped: 0,
        revalidationBlocked: false,
      });
      mockPullAndApply.mockClear();

      const getDb = vi.fn().mockReturnValue({});
      registerSyncIpc(getDb);

      const handler = getHandler(SYNC_CHANNELS.START_SYNC);
      const result = (await handler(
        {},
        { apiBaseUrl: "http://localhost:3000/api/v1", token: "test-token" },
      )) as { synced: number };

      expect(result.synced).toBe(5);
      // pullAndApply SHOULD have been called when push is clean
      expect(mockPullAndApply).toHaveBeenCalledTimes(1);
    });
  });

  describe("sync:pull handler", () => {
    it("is registered and returns a PullResult shape", async () => {
      const getDb = vi.fn().mockImplementation(() => {
        throw new Error("DB unavailable");
      });

      registerSyncIpc(getDb);

      const handler = getHandler(SYNC_CHANNELS.PULL);
      const result = (await handler()) as Record<string, unknown>;

      expect(result).toBeDefined();
      expect(result).toHaveProperty("applied");
      expect(result).toHaveProperty("skipped");
      expect(result).toHaveProperty("cursor");
      expect(result).toHaveProperty("hasMore");
    });

    it("returns safe stub when called without auth params", async () => {
      const getDb = vi.fn();

      registerSyncIpc(getDb);

      const handler = getHandler(SYNC_CHANNELS.PULL);
      const result = (await handler({}, undefined)) as Record<string, unknown>;

      expect(result).toEqual({
        applied: 0,
        skipped: 0,
        cursor: null,
        hasMore: false,
      });
    });
  });

  // -----------------------------------------------------------------------
  // createBackendPushFn — DTO serialization contract
  // -----------------------------------------------------------------------

  describe("createBackendPushFn DTO serialization", () => {
    function buildEntry(overrides: Partial<OutboxEntryRow> = {}): OutboxEntryRow {
      return {
        id: "entry-uuid-1",
        idempotency_key: "ik-abc123",
        operation_type: "sale_create",
        aggregate_type: "sale",
        aggregate_id: "sale-1",
        payload: JSON.stringify({ total: "100.00", items: 3 }),
        status: "pending",
        base_server_version: null,
        actor_user_id: "user-1",
        attempt_count: 1,
        next_retry_at: null,
        last_error: null,
        server_result: null,
        created_at: "2026-07-20T10:00:00.000Z",
        updated_at: "2026-07-20T10:00:00.000Z",
        synced_at: null,
        local_device_timestamp: overrides.local_device_timestamp ?? null,
        manual_fix_reason: overrides.manual_fix_reason ?? null,
        entity_label: overrides.entity_label ?? null,
        ...overrides,
      } as OutboxEntryRow;
    }

    it("serializes id and created_at into /sync/push request entries", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
      global.fetch = fetchMock as unknown as typeof global.fetch;

      const pushFn = createBackendPushFn(
        "http://localhost:3000/api/v1",
        "test-token",
      );

      const entry = buildEntry();
      await pushFn([entry]);

      // Extract the request body sent to fetch
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);

      expect(body.entries).toHaveLength(1);
      const sent = body.entries[0];

      // Core contract: every push entry MUST include id and created_at
      expect(sent.id).toBe("entry-uuid-1");
      expect(sent.created_at).toBe("2026-07-20T10:00:00.000Z");
    });

    it("includes id and created_at for every entry in a batch", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
      global.fetch = fetchMock as unknown as typeof global.fetch;

      const pushFn = createBackendPushFn(
        "http://localhost:3000/api/v1",
        "test-token",
      );

      const e1 = buildEntry({ id: "e-1", created_at: "2026-01-01T00:00:00Z" });
      const e2 = buildEntry({ id: "e-2", created_at: "2026-02-02T00:00:00Z" });
      const e3 = buildEntry({ id: "e-3", created_at: "2026-03-03T00:00:00Z" });

      await pushFn([e1, e2, e3]);

      const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);

      expect(body.entries).toHaveLength(3);

      // Every entry must have its own id and created_at
      expect(body.entries[0].id).toBe("e-1");
      expect(body.entries[0].created_at).toBe("2026-01-01T00:00:00Z");
      expect(body.entries[1].id).toBe("e-2");
      expect(body.entries[1].created_at).toBe("2026-02-02T00:00:00Z");
      expect(body.entries[2].id).toBe("e-3");
      expect(body.entries[2].created_at).toBe("2026-03-03T00:00:00Z");
    });

    it("includes idempotency_key and operation_type alongside id/created_at", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
      global.fetch = fetchMock as unknown as typeof global.fetch;

      const pushFn = createBackendPushFn(
        "http://localhost:3000/api/v1",
        "test-token",
      );

      const entry = buildEntry({
        idempotency_key: "ik-stock-adj",
        operation_type: "stock_adjust",
        aggregate_type: "stock",
        aggregate_id: "stock-prod-5",
      });

      await pushFn([entry]);

      const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      const sent = body.entries[0];

      expect(sent.id).toBe(entry.id);
      expect(sent.created_at).toBe(entry.created_at);
      expect(sent.idempotency_key).toBe("ik-stock-adj");
      expect(sent.operation_type).toBe("stock_adjust");
      expect(sent.aggregate_type).toBe("stock");
    });

    it("sends the correct Authorization header", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ results: [] }), { status: 200 }),
      );
      global.fetch = fetchMock as unknown as typeof global.fetch;

      const pushFn = createBackendPushFn(
        "http://localhost:3000/api/v1",
        "my-secret-token",
      );

      await pushFn([buildEntry()]);

      const [_url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.headers).toBeDefined();
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer my-secret-token");
      expect(headers["Content-Type"]).toBe("application/json");
    });
  });
});
