import { describe, expect, it, vi } from "vitest";
import { createBusyTracker, type BusyTracker } from "./busy-state";

describe("createBusyTracker", () => {
  let tracker: BusyTracker;

  function freshTracker(): BusyTracker {
    return createBusyTracker();
  }

  it("starts idle", () => {
    tracker = freshTracker();
    expect(tracker.isBusy()).toBe(false);
    expect(tracker.getState().busy).toBe(false);
    expect(tracker.getState().reasons).toHaveLength(0);
  });

  it("begin returns a token and marks busy", () => {
    tracker = freshTracker();
    const token = tracker.begin("sale", "Test sale");
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    expect(tracker.isBusy()).toBe(true);
    expect(tracker.getState().busy).toBe(true);
    expect(tracker.getState().reasons).toHaveLength(1);
    expect(tracker.getState().reasons[0].kind).toBe("sale");
  });

  it("end clears the token and returns to idle", () => {
    tracker = freshTracker();
    const token = tracker.begin("write", "DB write");
    tracker.end(token);
    expect(tracker.isBusy()).toBe(false);
    expect(tracker.getState().reasons).toHaveLength(0);
  });

  it("remains busy while at least one token is active", () => {
    tracker = freshTracker();
    const t1 = tracker.begin("sale", "Sale A");
    const t2 = tracker.begin("sync", "Sync pull");
    expect(tracker.isBusy()).toBe(true);
    expect(tracker.getState().reasons).toHaveLength(2);

    tracker.end(t1);
    expect(tracker.isBusy()).toBe(true);
    expect(tracker.getState().reasons).toHaveLength(1);
    expect(tracker.getState().reasons[0].kind).toBe("sync");

    tracker.end(t2);
    expect(tracker.isBusy()).toBe(false);
  });

  it("ending an unknown token is a no-op", () => {
    tracker = freshTracker();
    tracker.begin("sale", "Real sale");
    tracker.end("nonexistent-token");
    expect(tracker.isBusy()).toBe(true);
    expect(tracker.getState().reasons).toHaveLength(1);
  });

  it("fires onChange exactly once per transition", () => {
    tracker = freshTracker();
    const listener = vi.fn();
    tracker.onChange(listener);

    const token = tracker.begin("write", "Write");
    expect(listener).toHaveBeenCalledTimes(1);
    const idleToBusy = listener.mock.calls[0][0];
    expect(idleToBusy.busy).toBe(true);

    tracker.end(token);
    expect(listener).toHaveBeenCalledTimes(2);
    const busyToIdle = listener.mock.calls[1][0];
    expect(busyToIdle.busy).toBe(false);
  });

  it("does NOT fire onChange when busy→busy or idle→idle", () => {
    tracker = freshTracker();
    const listener = vi.fn();
    tracker.onChange(listener);

    // First begin: idle → busy (fires)
    const t1 = tracker.begin("sale", "A");
    expect(listener).toHaveBeenCalledTimes(1);

    // Second begin: busy → busy (no fire)
    const t2 = tracker.begin("sync", "B");
    expect(listener).toHaveBeenCalledTimes(1);

    // End one: busy → busy (no fire)
    tracker.end(t1);
    expect(listener).toHaveBeenCalledTimes(1);

    // End last: busy → idle (fires)
    tracker.end(t2);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("runProtectedOperation returns function result on success", async () => {
    tracker = freshTracker();
    const result = await tracker.runProtectedOperation("write", "test op", async () => 42);
    expect(result).toBe(42);
    expect(tracker.isBusy()).toBe(false);
  });

  it("runProtectedOperation clears token on failure and rethrows", async () => {
    tracker = freshTracker();
    const error = new Error("boom");
    await expect(
      tracker.runProtectedOperation("write", "failing op", async () => {
        throw error;
      })
    ).rejects.toBe(error);
    expect(tracker.isBusy()).toBe(false);
  });

  it("runProtectedOperation marks busy while executing", async () => {
    tracker = freshTracker();
    let capturedBusy = false;
    await tracker.runProtectedOperation("sync", "test sync", async () => {
      capturedBusy = tracker.isBusy();
    });
    expect(capturedBusy).toBe(true);
  });

  it("clearTokensForRendererView removes tokens for a given webContents", () => {
    tracker = freshTracker();
    const token = tracker.begin("sale", "Sale from renderer", { webContentsId: 42 });

    expect(tracker.isBusy()).toBe(true);

    tracker.clearTokensForRendererView(42);
    expect(tracker.isBusy()).toBe(false);
  });

  it("clearTokensForRendererView does not remove tokens from other views", () => {
    tracker = freshTracker();
    tracker.begin("sale", "View 42", { webContentsId: 42 });
    tracker.begin("sync", "View 99", { webContentsId: 99 });

    tracker.clearTokensForRendererView(42);
    expect(tracker.isBusy()).toBe(true);
    expect(tracker.getState().reasons).toHaveLength(1);
    expect(tracker.getState().reasons[0].kind).toBe("sync");
  });
});
