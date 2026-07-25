import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockApp } = vi.hoisted(() => ({
  mockApp: { isPackaged: true }
}));

vi.mock("electron", () => ({
  app: mockApp
}));

vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn()
  }
}));

import { waitForServerReady } from "./next-server";

class FakeChildProcess extends EventEmitter {}

describe("waitForServerReady", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("resolves once the packaged server becomes reachable", async () => {
    const child = new FakeChildProcess();
    const probe = vi.fn<[string], Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const readyPromise = waitForServerReady({
      child,
      url: "http://127.0.0.1:3002/",
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      probe
    });

    await vi.advanceTimersByTimeAsync(200);

    await expect(readyPromise).resolves.toBeUndefined();
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("fails with a clear timeout reason when the packaged server never responds", async () => {
    const child = new FakeChildProcess();
    const probe = vi.fn<[string], Promise<boolean>>().mockRejectedValue(new Error("connect ECONNREFUSED"));

    const readyPromise = waitForServerReady({
      child,
      url: "http://127.0.0.1:3002/",
      timeoutMs: 500,
      pollIntervalMs: 100,
      probe
    });

    const rejection = expect(readyPromise).rejects.toThrow(
      "Timed out waiting for packaged Next server at http://127.0.0.1:3002/ after 500ms (connect ECONNREFUSED)"
    );

    await vi.advanceTimersByTimeAsync(500);
    await rejection;
  });

  it("fails when the packaged server process exits before becoming ready", async () => {
    const child = new FakeChildProcess();
    const probe = vi.fn<[string], Promise<boolean>>().mockResolvedValue(false);

    const readyPromise = waitForServerReady({
      child,
      url: "http://127.0.0.1:3002/",
      timeoutMs: 1_000,
      pollIntervalMs: 100,
      probe
    });

    const rejection = expect(readyPromise).rejects.toThrow(
      "Packaged Next server exited before becoming ready (code: 1, signal: none)"
    );

    child.emit("exit", 1, null);

    await rejection;
  });
});
