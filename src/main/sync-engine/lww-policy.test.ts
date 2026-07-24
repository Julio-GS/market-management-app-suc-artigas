import { describe, expect, it } from "vitest";
import { resolveLww, resolveProductLww } from "./lww-policy";

// ---------------------------------------------------------------------------
// Slice 1 RED — this test must FAIL because lww-policy.ts does not exist yet.
// ---------------------------------------------------------------------------

describe("resolveLww (pure policy)", () => {
  it("returns null when local timestamp is null", () => {
    expect(resolveLww(null, "2026-07-20T12:00:00.000Z")).toBeNull();
  });

  it("returns null when server timestamp is null", () => {
    expect(resolveLww("2026-07-20T12:00:00.000Z", null)).toBeNull();
  });

  it("returns null when both timestamps are null", () => {
    expect(resolveLww(null, null)).toBeNull();
  });

  it("returns null when local timestamp is invalid", () => {
    expect(resolveLww("not-a-date", "2026-07-20T12:00:00.000Z")).toBeNull();
  });

  it("returns null when server timestamp is invalid", () => {
    expect(resolveLww("2026-07-20T12:00:00.000Z", "not-a-date")).toBeNull();
  });

  it("returns true when local timestamp is strictly newer (local wins)", () => {
    expect(
      resolveLww("2026-07-20T15:00:00.000Z", "2026-07-20T12:00:00.000Z"),
    ).toBe(true);
  });

  it("returns false when server timestamp is strictly newer (server wins)", () => {
    expect(
      resolveLww("2026-07-20T10:00:00.000Z", "2026-07-20T12:00:00.000Z"),
    ).toBe(false);
  });

  it("returns false when timestamps are equal (server wins tie)", () => {
    expect(
      resolveLww("2026-07-20T12:00:00.000Z", "2026-07-20T12:00:00.000Z"),
    ).toBe(false);
  });
});

describe("resolveProductLww (deprecated alias)", () => {
  it("delegates to resolveLww", () => {
    expect(
      resolveProductLww("2026-07-20T15:00:00.000Z", "2026-07-20T12:00:00.000Z"),
    ).toBe(true);
    expect(
      resolveProductLww("2026-07-20T10:00:00.000Z", "2026-07-20T12:00:00.000Z"),
    ).toBe(false);
    expect(resolveProductLww(null, "2026-07-20T12:00:00.000Z")).toBeNull();
  });
});
