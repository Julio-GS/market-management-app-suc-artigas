import { ipcMain, type WebContents } from "electron";
import { autoUpdater } from "electron-updater";
import log from "electron-log";
import type { DesktopConfig } from "./config";
import { getUpdateStatus, type UpdateStatus } from "./updater-status";

export const UPDATE_CHANNELS = {
  GET_STATUS: "updates:get-status",
  CHECK: "updates:check",
  DOWNLOAD: "updates:download",
  INSTALL_AND_RESTART: "updates:install-and-restart",
  STATUS: "updates:status"
} as const;

export interface UpdateEventPayload {
  type:
    | "disabled"
    | "checking"
    | "available"
    | "not-available"
    | "download-progress"
    | "downloaded"
    | "error";
  message?: string;
  percent?: number;
  version?: string;
}

function publishUpdateEvent(webContents: WebContents, payload: UpdateEventPayload): void {
  webContents.send(UPDATE_CHANNELS.STATUS, payload);
}

export function configureAutoUpdater(config: DesktopConfig): UpdateStatus {
  const status = getUpdateStatus(config);

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = log;

  if (!status.enabled) {
    return status;
  }

  autoUpdater.setFeedURL({
    provider: "generic",
    url: config.updates.url
  });

  return status;
}

export function registerUpdaterIpc(config: DesktopConfig, webContents: WebContents): UpdateStatus {
  const status = configureAutoUpdater(config);

  autoUpdater.removeAllListeners();

  autoUpdater.on("checking-for-update", () => {
    publishUpdateEvent(webContents, { type: "checking" });
  });

  autoUpdater.on("update-available", (info) => {
    publishUpdateEvent(webContents, {
      type: "available",
      version: info.version,
      message: `Version ${info.version} is available.`
    });
  });

  autoUpdater.on("update-not-available", () => {
    publishUpdateEvent(webContents, { type: "not-available", message: "No update is available." });
  });

  autoUpdater.on("download-progress", (progress) => {
    publishUpdateEvent(webContents, { type: "download-progress", percent: progress.percent });
  });

  autoUpdater.on("update-downloaded", (info) => {
    publishUpdateEvent(webContents, {
      type: "downloaded",
      version: info.version,
      message: "Update downloaded. It can be installed now."
    });
  });

  autoUpdater.on("error", (error) => {
    publishUpdateEvent(webContents, { type: "error", message: error.message });
  });

  ipcMain.handle(UPDATE_CHANNELS.GET_STATUS, () => status);

  ipcMain.handle(UPDATE_CHANNELS.CHECK, async () => {
    if (!status.enabled) {
      publishUpdateEvent(webContents, { type: "disabled", message: status.reason });
      return status;
    }

    return autoUpdater.checkForUpdates();
  });

  ipcMain.handle(UPDATE_CHANNELS.DOWNLOAD, async () => {
    if (!status.enabled) {
      publishUpdateEvent(webContents, { type: "disabled", message: status.reason });
      return status;
    }

    return autoUpdater.downloadUpdate();
  });

  ipcMain.handle(UPDATE_CHANNELS.INSTALL_AND_RESTART, () => {
    if (!status.enabled) {
      publishUpdateEvent(webContents, { type: "disabled", message: status.reason });
      return status;
    }

    autoUpdater.quitAndInstall(false, true);
    return { enabled: true } satisfies UpdateStatus;
  });

  return status;
}
