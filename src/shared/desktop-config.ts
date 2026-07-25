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

export function encodeDesktopConfig(config: DesktopConfig): string {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}

export function decodeDesktopConfig(encoded: string): DesktopConfig {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as DesktopConfig;
}
