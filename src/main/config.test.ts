import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeDesktopConfig, encodeDesktopConfig, resolveDesktopConfig } from "./config";

function writeTempConfig(content: unknown): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "market-desktop-config-"));
  const file = path.join(directory, "config.json");
  fs.writeFileSync(file, JSON.stringify(content), "utf8");
  return file;
}

describe("resolveDesktopConfig", () => {
  it("prefers environment values over user and default config files", () => {
    const defaultConfigPath = writeTempConfig({ apiBaseUrl: "http://default/api", frontendDevUrl: "http://default-ui" });
    const userConfigPath = writeTempConfig({ apiBaseUrl: "http://user/api", frontendDevUrl: "http://user-ui" });

    const config = resolveDesktopConfig({
      env: {
        MARKET_API_BASE_URL: "http://env/api",
        FRONTEND_DEV_URL: "http://env-ui"
      },
      defaultConfigPath,
      userConfigPath,
      appVersion: "1.2.3"
    });

    expect(config.apiBaseUrl).toBe("http://env/api");
    expect(config.frontendDevUrl).toBe("http://env-ui");
    expect(config.appVersion).toBe("1.2.3");
  });

  it("uses user config before packaged defaults", () => {
    const defaultConfigPath = writeTempConfig({ apiBaseUrl: "http://default/api" });
    const userConfigPath = writeTempConfig({ apiBaseUrl: "http://user/api" });

    const config = resolveDesktopConfig({ env: {}, defaultConfigPath, userConfigPath });

    expect(config.apiBaseUrl).toBe("http://user/api");
  });

  it("keeps updates disabled unless config explicitly enables them", () => {
    const config = resolveDesktopConfig({ env: {} });

    expect(config.updateEnabled).toBe(false);
    expect(config.updates.enabled).toBe(false);
  });
});

describe("desktop config encoding", () => {
  it("round-trips config for preload additionalArguments", () => {
    const config = resolveDesktopConfig({ env: { MARKET_API_BASE_URL: "http://localhost:3000/api/v1" }, appVersion: "0.1.0" });

    expect(decodeDesktopConfig(encodeDesktopConfig(config))).toEqual(config);
  });
});
