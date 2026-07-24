import type { DesktopConfig } from "./config";

export interface UpdateStatus {
  enabled: boolean;
  reason?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function getUpdateStatus(config: DesktopConfig): UpdateStatus {
  if (!config.updates.enabled) {
    return { enabled: false, reason: "Updates are disabled by configuration." };
  }

  if (!config.updates.provider) {
    return { enabled: false, reason: "Updates require a provider and URL." };
  }

  if (config.updates.provider === "generic") {
    if (!isNonEmptyString(config.updates.url)) {
      return { enabled: false, reason: "Updates require a provider and URL." };
    }
    return { enabled: true };
  }

  if (config.updates.provider === "github") {
    if (!isNonEmptyString(config.updates.owner) || !isNonEmptyString(config.updates.repo)) {
      return { enabled: false, reason: "GitHub provider requires both owner and repository." };
    }
    return { enabled: true };
  }

  return { enabled: false, reason: "Unsupported update provider." };
}
