import { ipcMain, type WebContents } from "electron";
import { autoUpdater } from "electron-updater";
import log from "electron-log";
import type { DesktopConfig } from "./config";
import { getUpdateStatus, type UpdateStatus } from "./updater-status";
import type { BusyTracker } from "./busy-state";

export const UPDATE_CHANNELS = {
  GET_STATUS: "updates:get-status",
  CHECK: "updates:check",
  DOWNLOAD: "updates:download",
  INSTALL_AND_RESTART: "updates:install-and-restart",
  STATUS: "updates:status"
} as const;

/** Payload passed to the optional updater error reporter. */
export interface UpdaterErrorReport {
  error: Error;
  /** Which phase the error occurred in. */
  phase: "check-download" | "install";
  context: {
    state: UpdateRuntimeState;
    version?: string;
    message?: string;
  };
}

/**
 * Opt-in production observability hook for updater failures.
 * Set via {@link setUpdaterErrorReporter}. Undefined by default (backward compatible).
 */
export type UpdaterErrorReporter = (report: UpdaterErrorReport) => void;

let updaterErrorReporter: UpdaterErrorReporter | undefined;

/**
 * Register an optional error reporter for production observability.
 * Pass `undefined` to clear.
 */
export function setUpdaterErrorReporter(reporter: UpdaterErrorReporter | undefined): void {
  updaterErrorReporter = reporter;
}

/**
 * Runtime state the updater manages. Separate from the static config guard.
 */
export type UpdateRuntimeState =
  | "disabled"
  | "checking"
  | "available"
  | "download-progress"
  | "downloaded-pending"
  | "blocked-by-busy-state"
  | "installing"
  | "error"
  | "up-to-date";

export interface UpdateStatusPayload {
  state: UpdateRuntimeState;
  enabled: boolean;
  reason?: string;
  message?: string;
  version?: string;
  percent?: number;
  requiresUserAction?: boolean;
  busy?: boolean;
  busyReasons?: string[];
}

// Backward-compatible alias for the old event payload shape.
export interface UpdateEventPayload {
  type: UpdateRuntimeState;
  message?: string;
  percent?: number;
  version?: string;
  requiresUserAction?: boolean;
  busy?: boolean;
  busyReasons?: string[];
}

function publishUpdateEvent(webContents: WebContents, payload: UpdateStatusPayload): void {
  // Emit the full normalized payload so the renderer can consume state, enabled,
  // and reason directly. Keep `type` as a backward-compat alias for `state`.
  webContents.send(UPDATE_CHANNELS.STATUS, {
    ...payload,
    type: payload.state,
  });
}

export function configureAutoUpdater(config: DesktopConfig): UpdateStatus {
  const status = getUpdateStatus(config);

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = log;

  if (!status.enabled) {
    return status;
  }

  if (config.updates.provider === "github") {
    autoUpdater.setFeedURL({
      provider: "github",
      owner: config.updates.owner!,
      repo: config.updates.repo!,
      channel: config.updates.channel ?? "latest",
      private: config.updates.private ?? false,
    });
  } else {
    autoUpdater.setFeedURL({
      provider: "generic",
      url: config.updates.url,
    });
  }

      autoUpdater.allowDowngrade = config.updates.allowDowngrade ?? false;
  return status;
}

export function unregisterUpdaterIpc(): void {
  ipcMain.removeHandler(UPDATE_CHANNELS.GET_STATUS);
  ipcMain.removeHandler(UPDATE_CHANNELS.CHECK);
  ipcMain.removeHandler(UPDATE_CHANNELS.DOWNLOAD);
  ipcMain.removeHandler(UPDATE_CHANNELS.INSTALL_AND_RESTART);
}

export function registerUpdaterIpc(
  config: DesktopConfig,
  webContents: WebContents,
  busyTracker?: BusyTracker,
): UpdateStatus {
  unregisterUpdaterIpc();

  const status = configureAutoUpdater(config);

  // ---- runtime state ----
  let currentState: UpdateRuntimeState = status.enabled ? "up-to-date" : "disabled";
  let lastVersion: string | undefined;
  let isDownloaded = false;
  let deferredInstallPending = false;

  function emit(state: UpdateRuntimeState, extra?: Partial<UpdateStatusPayload>): void {
    currentState = state;
    publishUpdateEvent(webContents, {
      state,
      enabled: status.enabled,
      reason: status.reason,
      ...extra,
    });
  }

  // If busy tracker is available, listen for idle transitions to resume deferred install.
  if (busyTracker) {
    busyTracker.onChange((busyState) => {
      if (!busyState.busy && deferredInstallPending && isDownloaded && status.enabled) {
        deferredInstallPending = false;
        emit("installing", { version: lastVersion, message: "Deferred install resuming now." });
        try {
          autoUpdater.quitAndInstall(false, true);
        } catch (err) {
          updaterErrorReporter?.({
            error: err instanceof Error ? err : new Error(String(err)),
            phase: "install",
            context: { state: "error", version: lastVersion, message: err instanceof Error ? err.message : String(err) },
          });
          log.error("quitAndInstall failed during deferred resume", err);
          emit("error", {
            message: err instanceof Error ? err.message : "Install failed on deferred resume.",
          });
        }
      }
    });
  }

  autoUpdater.removeAllListeners();

  autoUpdater.on("checking-for-update", () => {
    emit("checking", { message: "Checking for update..." });
  });

  autoUpdater.on("update-available", (info) => {
    lastVersion = info.version;
    emit("available", {
      version: info.version,
      message: `Version ${info.version} is available.`,
    });
  });

  autoUpdater.on("update-not-available", () => {
    emit("up-to-date", { message: "No update is available." });
  });

  autoUpdater.on("download-progress", (progress) => {
    emit("download-progress", { percent: progress.percent });
  });

  autoUpdater.on("update-downloaded", (info) => {
    isDownloaded = true;
    lastVersion = info.version;
    emit("downloaded-pending", {
      version: info.version,
      message: "Update downloaded. It can be installed now.",
      requiresUserAction: true,
    });
  });

  autoUpdater.on("error", (error) => {
    isDownloaded = false;
    updaterErrorReporter?.({
      error,
      phase: "check-download",
      context: { state: currentState, message: error.message },
    });
    emit("error", { message: error.message });
  });

  // ---- IPC handlers ----

  ipcMain.handle(UPDATE_CHANNELS.GET_STATUS, (): UpdateStatusPayload => ({
    state: currentState,
    enabled: status.enabled,
    reason: status.reason,
    version: lastVersion,
    requiresUserAction: currentState === "downloaded-pending" || currentState === "available",
    busy: busyTracker?.isBusy(),
    busyReasons: busyTracker?.getState().reasons.map((r) => r.kind),
  }));

  ipcMain.handle(UPDATE_CHANNELS.CHECK, async () => {
    if (!status.enabled) {
      emit("disabled", { message: status.reason });
      return { state: currentState };
    }
    try {
      const result = await autoUpdater.checkForUpdates();
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      updaterErrorReporter?.({
        error,
        phase: "check-download",
        context: { state: currentState, message: error.message },
      });
      emit("error", { message: error.message });
      return { state: currentState };
    }
  });

  ipcMain.handle(UPDATE_CHANNELS.DOWNLOAD, async () => {
    if (!status.enabled) {
      emit("disabled", { message: status.reason });
      return { state: currentState };
    }
    try {
      const result = await autoUpdater.downloadUpdate();
      return result;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      updaterErrorReporter?.({
        error,
        phase: "check-download",
        context: { state: currentState, message: error.message },
      });
      emit("error", { message: error.message });
      return { state: currentState };
    }
  });

  ipcMain.handle(UPDATE_CHANNELS.INSTALL_AND_RESTART, () => {
    if (!status.enabled) {
      emit("disabled", { message: status.reason });
      return { state: currentState };
    }

    if (!isDownloaded) {
      emit("error", { message: "No downloaded update is pending." });
      return { state: currentState };
    }

    if (busyTracker?.isBusy()) {
      deferredInstallPending = true;
      const bs = busyTracker.getState();
      emit("blocked-by-busy-state", {
        version: lastVersion,
        message: "Install deferred — protected operation in progress.",
        busy: true,
        busyReasons: bs.reasons.map((r) => r.kind),
      });
      return { state: "blocked-by-busy-state" };
    }

    emit("installing", { version: lastVersion, message: "Installing update and restarting..." });
    try {
      autoUpdater.quitAndInstall(false, true);
      return { state: "installing" };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      updaterErrorReporter?.({
        error,
        phase: "install",
        context: { state: "error", version: lastVersion, message: error.message },
      });
      log.error("quitAndInstall failed", err);
      emit("error", {
        message: error.message,
      });
      return { state: currentState };
    }
  });

  return status;
}
