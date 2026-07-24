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

  it("keeps offline disabled by default for safe rollout", () => {
    const config = resolveDesktopConfig({ env: {} });

    expect(config.offline.enabled).toBe(false);
  });

  it("enables offline when user config sets offline.enabled to true", () => {
    const userConfigPath = writeTempConfig({ offline: { enabled: true } });

    const config = resolveDesktopConfig({ env: {}, userConfigPath });

    expect(config.offline.enabled).toBe(true);
  });

  it("defaults integrityCheckOnStartup to true", () => {
    const config = resolveDesktopConfig({ env: {} });

    expect(config.offline.integrityCheckOnStartup).toBe(true);
  });

  it("respects explicit integrityCheckOnStartup false", () => {
    const userConfigPath = writeTempConfig({ offline: { integrityCheckOnStartup: false } });

    const config = resolveDesktopConfig({ env: {}, userConfigPath });

    expect(config.offline.integrityCheckOnStartup).toBe(false);
  });

  it("resolves GitHub owner and repo from user config", () => {
    const userConfigPath = writeTempConfig({
      updates: { enabled: true, provider: "github", owner: "my-org", repo: "my-repo" }
    });

    const config = resolveDesktopConfig({ env: {}, userConfigPath });

    expect(config.updates.enabled).toBe(true);
    expect(config.updates.provider).toBe("github");
    expect(config.updates.owner).toBe("my-org");
    expect(config.updates.repo).toBe("my-repo");
  });

  it("resolves GitHub channel, private, and allowDowngrade from user config", () => {
    const userConfigPath = writeTempConfig({
      updates: {
        enabled: true,
        provider: "github",
        owner: "my-org",
        repo: "my-repo",
        channel: "beta",
        private: true,
        allowDowngrade: true
      }
    });

    const config = resolveDesktopConfig({ env: {}, userConfigPath });

    expect(config.updates.channel).toBe("beta");
    expect(config.updates.private).toBe(true);
    expect(config.updates.allowDowngrade).toBe(true);
  });

  it("defaults GitHub channel to undefined when not specified", () => {
    const userConfigPath = writeTempConfig({
      updates: { enabled: true, provider: "github", owner: "my-org", repo: "my-repo" }
    });

    const config = resolveDesktopConfig({ env: {}, userConfigPath });

    expect(config.updates.channel).toBeUndefined();
  });

  it("defaults GitHub private and allowDowngrade to false when not specified", () => {
    const userConfigPath = writeTempConfig({
      updates: { enabled: true, provider: "github", owner: "my-org", repo: "my-repo" }
    });

    const config = resolveDesktopConfig({ env: {}, userConfigPath });

    expect(config.updates.private).toBe(false);
    expect(config.updates.allowDowngrade).toBe(false);
  });

  it("keeps generic provider URL resolution working alongside GitHub fields", () => {
    const userConfigPath = writeTempConfig({
      updates: { enabled: true, provider: "generic", url: "https://updates.example.com/" }
    });

    const config = resolveDesktopConfig({ env: {}, userConfigPath });

    expect(config.updates.provider).toBe("generic");
    expect(config.updates.url).toBe("https://updates.example.com/");
    // GitHub fields are absent when not configured
    expect(config.updates.owner).toBeUndefined();
    expect(config.updates.repo).toBeUndefined();
  });

  it("resolves GitHub owner and repo from default config as fallback", () => {
    const defaultConfigPath = writeTempConfig({
      updates: {
        enabled: true,
        provider: "github",
        owner: "default-org",
        repo: "default-repo"
      }
    });

    const config = resolveDesktopConfig({ env: {}, defaultConfigPath });

    expect(config.updates.owner).toBe("default-org");
    expect(config.updates.repo).toBe("default-repo");
  });

  it("prefers user config GitHub fields over default config", () => {
    const defaultConfigPath = writeTempConfig({
      updates: { enabled: true, provider: "github", owner: "default-org", repo: "default-repo" }
    });
    const userConfigPath = writeTempConfig({
      updates: { owner: "user-org", repo: "user-repo" }
    });

    const config = resolveDesktopConfig({ env: {}, defaultConfigPath, userConfigPath });

    expect(config.updates.owner).toBe("user-org");
    expect(config.updates.repo).toBe("user-repo");
  });
});

describe("desktop config encoding", () => {
  it("round-trips config for preload additionalArguments", () => {
    const config = resolveDesktopConfig({ env: { MARKET_API_BASE_URL: "http://localhost:3000/api/v1" }, appVersion: "0.1.0" });

    expect(decodeDesktopConfig(encodeDesktopConfig(config))).toEqual(config);
  });

  it("round-trips GitHub config fields through encoding", () => {
    const config = resolveDesktopConfig({
      env: { MARKET_API_BASE_URL: "http://localhost:3000/api/v1" },
      appVersion: "0.2.0",
      userConfigPath: writeTempConfig({
        updates: {
          enabled: true,
          provider: "github",
          owner: "test-org",
          repo: "test-repo",
          channel: "latest",
          private: false,
          allowDowngrade: false
        }
      })
    });

    expect(decodeDesktopConfig(encodeDesktopConfig(config))).toEqual(config);
  });
});
