import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BusyTracker } from "./busy-state";
import type { BootstrapService } from "./application/bootstrap/bootstrap-service";

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
  BOOTSTRAP_CHANNELS,
  registerBootstrapIpc,
  unregisterBootstrapIpc,
} from "./adapters/bootstrap/bootstrap-ipc";

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const mockIpc = ipcMain as unknown as { _handlers: Map<string, (...args: unknown[]) => unknown> };
  const handler = mockIpc._handlers.get(channel);
  if (!handler) throw new Error(`Handler not found for channel: ${channel}`);
  return handler;
}

function createBootstrapService(): BootstrapService {
  return {
    getStatus: vi.fn(),
    start: vi.fn().mockResolvedValue({ status: "complete", ready: true, syncCursor: "cursor" }),
    resume: vi.fn().mockResolvedValue({ status: "complete", ready: true, syncCursor: "cursor" }),
  } as unknown as BootstrapService;
}

describe("bootstrap-ipc busyTracker integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    try {
      unregisterBootstrapIpc();
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

  it("BOOTSTRAP_START wraps with runProtectedOperation when busyTracker is provided", async () => {
    const service = createBootstrapService();
    registerBootstrapIpc(service, mockBusyTracker);

    const handler = getHandler(BOOTSTRAP_CHANNELS.BOOTSTRAP_START);
    const result = (await handler({}, { token: "test-token", apiBaseUrl: "http://localhost:3000/api/v1" })) as { status: string };

    expect(result.status).toBe("complete");
    expect(mockRunProtectedOp).toHaveBeenCalledWith("bootstrap", "Start bootstrap", expect.any(Function));
  });

  it("BOOTSTRAP_RESUME wraps with runProtectedOperation when busyTracker is provided", async () => {
    const service = createBootstrapService();
    registerBootstrapIpc(service, mockBusyTracker);

    const handler = getHandler(BOOTSTRAP_CHANNELS.BOOTSTRAP_RESUME);
    const result = (await handler({}, { token: "test-token", apiBaseUrl: "http://localhost:3000/api/v1" })) as { status: string };

    expect(result.status).toBe("complete");
    expect(mockRunProtectedOp).toHaveBeenCalledWith("bootstrap", "Resume bootstrap", expect.any(Function));
  });

  it("bootstrap handlers work without busyTracker", async () => {
    const service = createBootstrapService();
    registerBootstrapIpc(service);

    const startHandler = getHandler(BOOTSTRAP_CHANNELS.BOOTSTRAP_START);
    const resumeHandler = getHandler(BOOTSTRAP_CHANNELS.BOOTSTRAP_RESUME);

    await expect(startHandler({}, { token: "test-token", apiBaseUrl: "http://localhost:3000/api/v1" })).resolves.toMatchObject({ status: "complete" });
    await expect(resumeHandler({}, { token: "test-token", apiBaseUrl: "http://localhost:3000/api/v1" })).resolves.toMatchObject({ status: "complete" });
  });
});
