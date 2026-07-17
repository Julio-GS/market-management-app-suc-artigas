import { describe, expect, it } from "vitest";
import { getOrigin, isAllowedPermission, isAllowedRendererNavigation, shouldOpenExternally } from "./navigation";

describe("navigation guards", () => {
  const rendererOrigin = "http://127.0.0.1:3002";

  it("allows navigation only within the trusted renderer origin", () => {
    expect(isAllowedRendererNavigation("http://127.0.0.1:3002/productos", rendererOrigin)).toBe(true);
    expect(isAllowedRendererNavigation("http://localhost:3002/productos", rendererOrigin)).toBe(false);
    expect(isAllowedRendererNavigation("https://example.com", rendererOrigin)).toBe(false);
  });

  it("opens external http(s) URLs in the OS browser", () => {
    expect(shouldOpenExternally("https://example.com", rendererOrigin)).toBe(true);
    expect(shouldOpenExternally("http://example.com", rendererOrigin)).toBe(true);
    expect(shouldOpenExternally("file:///C:/secret.txt", rendererOrigin)).toBe(false);
    expect(shouldOpenExternally("http://127.0.0.1:3002/dashboard", rendererOrigin)).toBe(false);
  });

  it("allows media permissions only for the trusted renderer origin", () => {
    expect(isAllowedPermission("media", rendererOrigin, rendererOrigin)).toBe(true);
    expect(isAllowedPermission("notifications", rendererOrigin, rendererOrigin)).toBe(false);
    expect(isAllowedPermission("media", "https://example.com", rendererOrigin)).toBe(false);
  });

  it("returns null for invalid origins", () => {
    expect(getOrigin("not a url")).toBeNull();
  });
});
