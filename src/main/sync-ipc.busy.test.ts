import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusyTracker } from "./busy-state";

const { mockPullAndApply, mockReplayOutbox } = vi.hoisted(() => ({
  mockPullAndApply: vi.fn(),
  mockReplayOutbox: vi.fn(),
}));

vi.mock("./pull-reconciliation", () => ({
  pullAndApply: mockPullAndApply,
}));

vi.mock("./sync-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./sync-engine")>();
  return {
    ...actual,
    replayOutbox: mockReplayOutbox,
  };
});

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
} from "./adapters/sync/sync-ipc";

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const mockIpc = ipcMain as unknown as { _handlers: Map<string, (...args: unknown[]) => unknown> };
  const handler = mockIpc._handlers.get(channel);
  if (!handler) throw new Error(`Handler not found for channel: ${channel}`);
  return handler;
}

describe("sync-ipc busyTracker integration", () => {
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

  const mockRunProtectedOp = vi.fn(
    async (_kind: string, _label: string | undefined, fn: () => Promise<unknown>) => fn(),
  );
  const mockBusyTracker = {
    runProtectedOperation: mockRunProtectedOp,
  } as unknown as BusyTracker;

  it("START_SYNC wraps with runProtectedOperation when busyTracker is provided", async () => {
    const getDb = vi.fn().mockImplementation(() => {
      throw new Error("DB unavailable");
    });

    registerSyncIpc(getDb, undefined, mockBusyTracker);
    const handler = getHandler(SYNC_CHANNELS.START_SYNC);
    await handler();

    expect(mockRunProtectedOp).toHaveBeenCalledWith("sync", "Start sync", expect.any(Function));
  });

  it("PULL wraps with runProtectedOperation when busyTracker is provided", async () => {
    const getDb = vi.fn();

    registerSyncIpc(getDb, undefined, mockBusyTracker);
    const handler = getHandler(SYNC_CHANNELS.PULL);
    await handler({}, undefined);

    expect(mockRunProtectedOp).toHaveBeenCalledWith("sync", "Pull changes", expect.any(Function));
  });

  it("sync handlers work without busyTracker", async () => {
    const getDb = vi.fn().mockImplementation(() => {
      throw new Error("DB unavailable");
    });

    registerSyncIpc(getDb);
    const startHandler = getHandler(SYNC_CHANNELS.START_SYNC);
    const pullHandler = getHandler(SYNC_CHANNELS.PULL);

    await expect(startHandler()).resolves.toHaveProperty("synced");
    await expect(pullHandler({}, undefined)).resolves.toEqual({
      applied: 0,
      skipped: 0,
      cursor: null,
      hasMore: false,
    });
  });
});
