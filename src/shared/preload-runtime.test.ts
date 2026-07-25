import { describe, expect, it } from "vitest";
import { decodeDesktopConfig, encodeDesktopConfig, type DesktopConfig } from "./desktop-config";
import { OFFLINE_CHANNELS, UPDATE_CHANNELS } from "./ipc-channels";

describe("preload runtime shared modules", () => {
  it("round-trips desktop config without depending on main-process modules", () => {
    const config: DesktopConfig = {
      apiBaseUrl: "http://localhost:3000/api/v1",
      frontendDevUrl: "http://localhost:3001",
      appVersion: "1.2.3",
      updateEnabled: true,
      updates: { enabled: true, provider: "github", owner: "omnia", repo: "market-management-app" },
      offline: { enabled: true, integrityCheckOnStartup: true },
    };

    const encoded = encodeDesktopConfig(config);

    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeDesktopConfig(encoded)).toEqual(config);
  });

  it("decodes URL-safe config without requiring Node's base64url encoding", () => {
    const config: DesktopConfig = {
      apiBaseUrl: "http://localhost:3000/api/v1",
      frontendDevUrl: "http://localhost:3001",
      appVersion: "1.2.3",
      updateEnabled: true,
      updates: { enabled: true, provider: "github", owner: "omnia", repo: "market-management-app" },
      offline: { enabled: true, integrityCheckOnStartup: true },
    };
    const json = JSON.stringify(config);
    const encoded = Buffer.from(json, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");

    expect(decodeDesktopConfig(encoded)).toEqual(config);
  });

  it("exposes stable IPC channel constants for preload", () => {
    expect(UPDATE_CHANNELS.GET_STATUS).toBe("updates:get-status");
    expect(OFFLINE_CHANNELS.LOGIN).toBe("offline:login");
  });
});
