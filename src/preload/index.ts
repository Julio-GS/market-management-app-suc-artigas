import { contextBridge, ipcRenderer } from "electron";
import { decodeDesktopConfig, type DesktopConfig } from "../main/config";
import { UPDATE_CHANNELS, type UpdateEventPayload } from "../main/updater";
import type { UpdateStatus } from "../main/updater-status";

interface MarketDesktopBridge {
  getConfig(): DesktopConfig;
  platform: NodeJS.Platform;
  updates: {
    getStatus(): Promise<UpdateStatus>;
    check(): Promise<unknown>;
    download(): Promise<unknown>;
    installAndRestart(): Promise<unknown>;
    onStatus(callback: (payload: UpdateEventPayload) => void): () => void;
  };
}

function readEncodedDesktopConfig(): string | undefined {
  const prefix = "--market-desktop-config=";
  const argument = process.argv.find((value) => value.startsWith(prefix));
  return argument?.slice(prefix.length);
}

const encodedConfig = readEncodedDesktopConfig();
const desktopConfig: DesktopConfig = encodedConfig
  ? decodeDesktopConfig(encodedConfig)
  : {
      apiBaseUrl: "http://localhost:3000/api/v1",
      frontendDevUrl: "http://localhost:3001",
      appVersion: "0.0.0",
      updateEnabled: false,
      updates: { enabled: false }
    };

const marketDesktop: MarketDesktopBridge = {
  getConfig: () => desktopConfig,
  platform: process.platform,
  updates: {
    getStatus: () => ipcRenderer.invoke(UPDATE_CHANNELS.GET_STATUS) as Promise<UpdateStatus>,
    check: () => ipcRenderer.invoke(UPDATE_CHANNELS.CHECK),
    download: () => ipcRenderer.invoke(UPDATE_CHANNELS.DOWNLOAD),
    installAndRestart: () => ipcRenderer.invoke(UPDATE_CHANNELS.INSTALL_AND_RESTART),
    onStatus: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: UpdateEventPayload) => callback(payload);
      ipcRenderer.on(UPDATE_CHANNELS.STATUS, listener);
      return () => ipcRenderer.off(UPDATE_CHANNELS.STATUS, listener);
    }
  }
};

contextBridge.exposeInMainWorld("__MARKET_DESKTOP_CONFIG__", desktopConfig);
contextBridge.exposeInMainWorld("marketDesktop", marketDesktop);
