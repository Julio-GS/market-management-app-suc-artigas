import path from "node:path";
import { app, BrowserWindow, shell } from "electron";
import log from "electron-log";
import { encodeDesktopConfig, resolveDesktopConfig } from "./config";
import { isAllowedPermission, isAllowedRendererNavigation, shouldOpenExternally } from "./navigation";
import { startPackagedNextServer, stopPackagedNextServer } from "./next-server";
import { registerUpdaterIpc } from "./updater";
import { getUpdateStatus } from "./updater-status";

log.initialize();

function createBrowserWindow(encodedConfig: string): BrowserWindow {
  return new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 720,
    title: "Market Management",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      additionalArguments: [`--market-desktop-config=${encodedConfig}`],
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });
}

function registerNavigationGuards(window: BrowserWindow, allowedRendererOrigin: string): void {
  window.webContents.on("will-navigate", (event, targetUrl) => {
    if (isAllowedRendererNavigation(targetUrl, allowedRendererOrigin)) {
      return;
    }

    event.preventDefault();

    if (shouldOpenExternally(targetUrl, allowedRendererOrigin)) {
      void shell.openExternal(targetUrl);
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenExternally(url, allowedRendererOrigin)) {
      void shell.openExternal(url);
    }

    return { action: "deny" };
  });

  window.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
    try {
      const requestingOrigin = new URL(webContents.getURL()).origin;
      callback(isAllowedPermission(permission, requestingOrigin, allowedRendererOrigin));
    } catch {
      callback(false);
    }
  });
}

async function createWindow(): Promise<void> {
  const config = resolveDesktopConfig({
    appVersion: app.getVersion(),
    userConfigPath: path.join(app.getPath("userData"), "config.json"),
    defaultConfigPath: path.join(process.resourcesPath, "default-config.json")
  });

  const updateStatus = getUpdateStatus(config);
  const rendererConfig = {
    ...config,
    updateEnabled: updateStatus.enabled,
    updates: {
      ...config.updates,
      enabled: updateStatus.enabled
    }
  };
  log.info("market-management-desktop starting", { updateStatus });

  const encodedConfig = encodeDesktopConfig(rendererConfig);
  const window = createBrowserWindow(encodedConfig);
  registerUpdaterIpc(rendererConfig, window.webContents);
  const rendererUrl = app.isPackaged
    ? (await startPackagedNextServer()).url
    : config.frontendDevUrl;
  const allowedRendererOrigin = new URL(rendererUrl).origin;

  registerNavigationGuards(window, allowedRendererOrigin);
  await window.loadURL(rendererUrl);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) {
        window.restore();
      }
      window.focus();
    }
  });

  void app.whenReady().then(async () => {
    await createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  });
}

app.on("before-quit", () => {
  stopPackagedNextServer();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
