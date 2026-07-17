import { describe, expect, it } from "vitest";
import type { DesktopConfig } from "./config";
import { getUpdateStatus } from "./updater-status";

function configWithUpdates(updates: DesktopConfig["updates"]): DesktopConfig {
  return {
    apiBaseUrl: "http://localhost:3000/api/v1",
    frontendDevUrl: "http://localhost:3001",
    appVersion: "0.1.0",
    updateEnabled: updates.enabled,
    updates
  };
}

describe("getUpdateStatus", () => {
  it("keeps updates disabled by default", () => {
    expect(getUpdateStatus(configWithUpdates({ enabled: false }))).toEqual({
      enabled: false,
      reason: "Updates are disabled by configuration."
    });
  });

  it("requires provider and URL when updates are enabled", () => {
    expect(getUpdateStatus(configWithUpdates({ enabled: true }))).toEqual({
      enabled: false,
      reason: "Updates require a provider and URL."
    });
  });

  it("allows configured generic HTTPS provider", () => {
    expect(getUpdateStatus(configWithUpdates({ enabled: true, provider: "generic", url: "https://updates.example.com/app/" }))).toEqual({
      enabled: true
    });
  });

  it("does not enable unwired GitHub provider yet", () => {
    expect(getUpdateStatus(configWithUpdates({ enabled: true, provider: "github", url: "https://github.com/acme/app" }))).toEqual({
      enabled: false,
      reason: "Only the generic HTTPS update provider is wired in this slice."
    });
  });
});
