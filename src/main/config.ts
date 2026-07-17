import fs from "node:fs";

export interface UpdateConfig {
  enabled: boolean;
  provider?: "generic" | "github";
  url?: string;
}

export interface DesktopConfig {
  apiBaseUrl: string;
  frontendDevUrl: string;
  appVersion: string;
  updateEnabled: boolean;
  updates: UpdateConfig;
}

interface ConfigFileShape {
  apiBaseUrl?: unknown;
  frontendDevUrl?: unknown;
  updates?: {
    enabled?: unknown;
    provider?: unknown;
    url?: unknown;
  };
}

export interface ResolveDesktopConfigOptions {
  env?: NodeJS.ProcessEnv;
  userConfigPath?: string;
  defaultConfigPath?: string;
  appVersion?: string;
}

const DEFAULT_API_BASE_URL = "http://localhost:3001/api/v1";
const DEFAULT_FRONTEND_DEV_URL = "http://localhost:3000";

function readConfigFile(path?: string): ConfigFileShape {
  if (!path || !fs.existsSync(path)) {
    return {};
  }

  const raw = fs.readFileSync(path, "utf8");
  return JSON.parse(raw) as ConfigFileShape;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function updateProvider(value: unknown): UpdateConfig["provider"] | undefined {
  return value === "generic" || value === "github" ? value : undefined;
}

export function resolveDesktopConfig(options: ResolveDesktopConfigOptions = {}): DesktopConfig {
  const env = options.env ?? process.env;
  const defaultConfig = readConfigFile(options.defaultConfigPath);
  const userConfig = readConfigFile(options.userConfigPath);

  const apiBaseUrl =
    stringValue(env.MARKET_API_BASE_URL) ??
    stringValue(userConfig.apiBaseUrl) ??
    stringValue(defaultConfig.apiBaseUrl) ??
    DEFAULT_API_BASE_URL;

  const frontendDevUrl =
    stringValue(env.FRONTEND_DEV_URL) ??
    stringValue(userConfig.frontendDevUrl) ??
    stringValue(defaultConfig.frontendDevUrl) ??
    DEFAULT_FRONTEND_DEV_URL;

  const updateEnabled =
    booleanValue(userConfig.updates?.enabled) ??
    booleanValue(defaultConfig.updates?.enabled) ??
    false;

  return {
    apiBaseUrl,
    frontendDevUrl,
    appVersion: options.appVersion ?? "0.0.0",
    updateEnabled,
    updates: {
      enabled: updateEnabled,
      provider: updateProvider(userConfig.updates?.provider) ?? updateProvider(defaultConfig.updates?.provider),
      url: stringValue(userConfig.updates?.url) ?? stringValue(defaultConfig.updates?.url)
    }
  };
}

export function encodeDesktopConfig(config: DesktopConfig): string {
  return Buffer.from(JSON.stringify(config), "utf8").toString("base64url");
}

export function decodeDesktopConfig(encoded: string): DesktopConfig {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as DesktopConfig;
}
