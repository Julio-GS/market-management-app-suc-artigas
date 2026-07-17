import type { DesktopConfig } from "./config";

export interface UpdateStatus {
  enabled: boolean;
  reason?: string;
}

export function getUpdateStatus(config: DesktopConfig): UpdateStatus {
  if (!config.updates.enabled) {
    return { enabled: false, reason: "Updates are disabled by configuration." };
  }

  if (!config.updates.provider || !config.updates.url) {
    return { enabled: false, reason: "Updates require a provider and URL." };
  }

  if (config.updates.provider !== "generic") {
    return { enabled: false, reason: "Only the generic HTTPS update provider is wired in this slice." };
  }

  return { enabled: true };
}
