export interface UpdateConfig {
  enabled: boolean;
  provider?: "generic" | "github";
  url?: string;
  /** GitHub Releases owner (required when provider is "github"). */
  owner?: string;
  /** GitHub Releases repository (required when provider is "github"). */
  repo?: string;
  /** Release channel. Defaults to "latest" at feed-setup time. */
  channel?: string;
  /** Private repository distribution. Defaults to false. */
  private?: boolean;
  /** Allow downgrade to a lower version. Defaults to false. */
  allowDowngrade?: boolean;
}

export interface OfflineConfig {
  /** Whether offline capability is enabled. Defaults to false (safe rollout). */
  enabled: boolean;
  /** Override the local DB directory for testing or recovery. */
  dbPath?: string;
  /** Run integrity_check on every startup. Defaults to true. */
  integrityCheckOnStartup: boolean;
  /**
   * Default admin credentials seeded into SQLite on first launch.
   * Allows the app to work fully offline without any prior online login.
   * Password is stored as a scrypt hash — never persisted in plaintext.
   */
  defaultAdmin?: {
    username: string;
    password: string;
  };
}

export interface DesktopConfig {
  apiBaseUrl: string;
  frontendDevUrl: string;
  appVersion: string;
  updateEnabled: boolean;
  updates: UpdateConfig;
  offline: OfflineConfig;
}

function toUrlSafeBase64(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromUrlSafeBase64(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const paddedBase64 = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  return Buffer.from(paddedBase64, "base64").toString("utf8");
}

export function encodeDesktopConfig(config: DesktopConfig): string {
  return toUrlSafeBase64(JSON.stringify(config));
}

export function decodeDesktopConfig(encoded: string): DesktopConfig {
  return JSON.parse(fromUrlSafeBase64(encoded)) as DesktopConfig;
}
