import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must come before imports that use them
// Use vi.hoisted so the references are available when vi.mock factories are hoisted.
// ---------------------------------------------------------------------------

const { mockIpcHandlers, mockSentEvents, mockAutoUpdater } = vi.hoisted(() => {
  const mockIpcHandlers = new Map<string, (...args: any[]) => any>();
  const mockSentEvents: any[] = [];
  const listeners: Record<string, (...args: any[]) => void> = {};
  const mockAutoUpdater: any = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    logger: null,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    removeAllListeners: vi.fn(() => {
      for (const key of Object.keys(listeners)) {
        delete listeners[key];
      }
    }),
    on: vi.fn((event: string, fn: (...args: any[]) => void) => {
      listeners[event] = fn;
    }),
    _listeners: listeners,
  };
  return { mockIpcHandlers, mockSentEvents, mockAutoUpdater };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: any[]) => any) => {
      mockIpcHandlers.set(channel, handler);
    }),
    removeHandler: vi.fn((channel: string) => {
      mockIpcHandlers.delete(channel);
    }),
  },
}));

vi.mock("electron-updater", () => ({
  autoUpdater: mockAutoUpdater,
}));

vi.mock("electron-log", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

import { ipcMain } from "electron";
import type { DesktopConfig } from "./config";
import { createBusyTracker } from "./busy-state";
import {
  registerUpdaterIpc,
  setUpdaterErrorReporter,
  unregisterUpdaterIpc,
  UPDATE_CHANNELS,
} from "./updater";
import { getUpdateStatus } from "./updater-status";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function configWithUpdates(updates: DesktopConfig["updates"]): DesktopConfig {
  return {
    apiBaseUrl: "http://localhost:3000/api/v1",
    frontendDevUrl: "http://localhost:3001",
    appVersion: "0.1.0",
    updateEnabled: updates.enabled,
    updates,
    offline: { enabled: false, integrityCheckOnStartup: true },
  };
}

function enabledGitHubConfig(): DesktopConfig {
  return configWithUpdates({
    enabled: true,
    provider: "github",
    owner: "acme",
    repo: "my-app",
  });
}

function mockWebContents(): any {
  return {
    send: vi.fn((channel: string, payload: any) => {
      mockSentEvents.push({ channel, payload });
    }),
    id: 1,
  };
}

function resetMocks() {
  mockIpcHandlers.clear();
  mockSentEvents.length = 0;
  mockAutoUpdater.setFeedURL.mockReset();
  mockAutoUpdater.checkForUpdates.mockReset();
  mockAutoUpdater.downloadUpdate.mockReset();
  mockAutoUpdater.quitAndInstall.mockReset();
  mockAutoUpdater.removeAllListeners.mockReset();
  mockAutoUpdater.on.mockReset();
  mockAutoUpdater.autoDownload = false;
  mockAutoUpdater.autoInstallOnAppQuit = false;
  // Re-establish on listener capture after reset
  const listeners: Record<string, (...args: any[]) => void> = {};
  mockAutoUpdater._listeners = listeners;
  mockAutoUpdater.on.mockImplementation((event: string, fn: (...args: any[]) => void) => {
    listeners[event] = fn;
  });
  mockAutoUpdater.removeAllListeners.mockImplementation(() => {
    for (const key of Object.keys(listeners)) {
      delete listeners[key];
    }
  });
}

/** Retrieve the last event emitted to the renderer via webContents.send. */
function lastSentEvent(): any {
  return mockSentEvents[mockSentEvents.length - 1]?.payload;
}

// ---------------------------------------------------------------------------
// Static config guard tests (existing, preserved)
// ---------------------------------------------------------------------------

describe("getUpdateStatus", () => {
  it("keeps updates disabled by default", () => {
    expect(getUpdateStatus(configWithUpdates({ enabled: false }))).toEqual({
      enabled: false,
      reason: "Updates are disabled by configuration.",
    });
  });

  it("requires provider and URL when updates are enabled", () => {
    expect(getUpdateStatus(configWithUpdates({ enabled: true }))).toEqual({
      enabled: false,
      reason: "Updates require a provider and URL.",
    });
  });

  it("allows configured generic HTTPS provider", () => {
    expect(
      getUpdateStatus(
        configWithUpdates({
          enabled: true,
          provider: "generic",
          url: "https://updates.example.com/app/",
        }),
      ),
    ).toEqual({ enabled: true });
  });

  it("accepts GitHub provider with owner and repo", () => {
    expect(
      getUpdateStatus(
        configWithUpdates({
          enabled: true,
          provider: "github",
          owner: "acme",
          repo: "my-app",
        }),
      ),
    ).toEqual({ enabled: true });
  });

  it("accepts GitHub provider with channel", () => {
    expect(
      getUpdateStatus(
        configWithUpdates({
          enabled: true,
          provider: "github",
          owner: "acme",
          repo: "my-app",
          channel: "beta",
        }),
      ),
    ).toEqual({ enabled: true });
  });

  it("rejects GitHub provider without owner", () => {
    expect(
      getUpdateStatus(
        configWithUpdates({
          enabled: true,
          provider: "github",
          repo: "my-app",
        }),
      ),
    ).toEqual({
      enabled: false,
      reason: "GitHub provider requires both owner and repository.",
    });
  });

  it("rejects GitHub provider without repo", () => {
    expect(
      getUpdateStatus(
        configWithUpdates({
          enabled: true,
          provider: "github",
          owner: "acme",
        }),
      ),
    ).toEqual({
      enabled: false,
      reason: "GitHub provider requires both owner and repository.",
    });
  });

  it("rejects GitHub provider with empty owner", () => {
    expect(
      getUpdateStatus(
        configWithUpdates({
          enabled: true,
          provider: "github",
          owner: "  ",
          repo: "my-app",
        }),
      ),
    ).toEqual({
      enabled: false,
      reason: "GitHub provider requires both owner and repository.",
    });
  });

  it("preserves generic provider fallback", () => {
    expect(
      getUpdateStatus(
        configWithUpdates({
          enabled: true,
          provider: "generic",
          url: "https://updates.example.com/app/",
        }),
      ),
    ).toEqual({ enabled: true });
  });

  it("rejects generic provider without URL", () => {
    expect(
      getUpdateStatus(
        configWithUpdates({
          enabled: true,
          provider: "generic",
        }),
      ),
    ).toEqual({
      enabled: false,
      reason: "Updates require a provider and URL.",
    });
  });
});

// ---------------------------------------------------------------------------
// Runtime state machine tests (Blocker 2 remediation)
// ---------------------------------------------------------------------------

describe("registerUpdaterIpc runtime", () => {
  let wc: any;

  beforeEach(() => {
    resetMocks();
    wc = mockWebContents();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function fireAutoUpdaterEvent(event: string, ...args: any[]): void {
    const fn = mockAutoUpdater._listeners?.[event];
    if (fn) fn(...args);
  }

  describe("initialisation", () => {
    it("sets internal state to up-to-date when updates are enabled (queryable via getStatus)", () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.GET_STATUS);
      const status = handler!();
      expect(status.state).toBe("up-to-date");
    });

    it("sets internal state to disabled when updates are disabled (queryable via getStatus)", () => {
      registerUpdaterIpc(configWithUpdates({ enabled: false }), wc);
      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.GET_STATUS);
      const status = handler!();
      expect(status.state).toBe("disabled");
    });

    it("preserves autoDownload=false and autoInstallOnAppQuit=false", () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      expect(mockAutoUpdater.autoDownload).toBe(false);
      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false);
    });
  });

  describe("updates:get-status", () => {
    it("returns current state", () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.GET_STATUS);
      expect(handler).toBeDefined();
      const status = handler!();
      expect(status.state).toBe("up-to-date");
      expect(status.enabled).toBe(true);
    });

    it("returns disabled state when config is disabled", () => {
      registerUpdaterIpc(configWithUpdates({ enabled: false }), wc);
      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.GET_STATUS);
      const status = handler!();
      expect(status.state).toBe("disabled");
      expect(status.enabled).toBe(false);
    });
  });

  describe("updates:check", () => {
    it("calls autoUpdater.checkForUpdates when enabled", async () => {
      mockAutoUpdater.checkForUpdates.mockResolvedValue({});
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.CHECK);
      await handler!();
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    });

    it("emits disabled and does not check when updates are disabled", async () => {
      registerUpdaterIpc(configWithUpdates({ enabled: false }), wc);
      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.CHECK);
      mockSentEvents.length = 0;
      const result = await handler!();
      expect(result.state).toBe("disabled");
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled();
    });
  });

  describe("updates:download", () => {
    it("calls autoUpdater.downloadUpdate when enabled", async () => {
      mockAutoUpdater.downloadUpdate.mockResolvedValue([]);
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.DOWNLOAD);
      await handler!();
      expect(mockAutoUpdater.downloadUpdate).toHaveBeenCalledOnce();
    });

    it("does not auto-download before user action (no downloadUpdate call on available)", () => {
      mockAutoUpdater.downloadUpdate.mockResolvedValue([]);
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      fireAutoUpdaterEvent("update-available", { version: "0.2.0" });
      expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
    });

    it("emits disabled and does not download when updates are disabled", async () => {
      registerUpdaterIpc(configWithUpdates({ enabled: false }), wc);
      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.DOWNLOAD);
      mockSentEvents.length = 0;
      const result = await handler!();
      expect(result.state).toBe("disabled");
      expect(mockAutoUpdater.downloadUpdate).not.toHaveBeenCalled();
    });
  });

  describe("normalized status payload", () => {
    it("emits state, enabled, and reason alongside backward-compat type", () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      mockSentEvents.length = 0;
      fireAutoUpdaterEvent("checking-for-update");
      const evt = lastSentEvent();
      expect(evt.state).toBe("checking");
      expect(evt.enabled).toBe(true);
      expect(evt.type).toBe("checking");
    });

    it("includes enabled:false and reason when updates are disabled", () => {
      registerUpdaterIpc(configWithUpdates({ enabled: false }), wc);
      mockSentEvents.length = 0;
      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.GET_STATUS);
      const status = handler!();
      expect(status.state).toBe("disabled");
      expect(status.enabled).toBe(false);
      expect(status.reason).toBe("Updates are disabled by configuration.");
    });

    it("emits version in the normalized event payload", () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      mockSentEvents.length = 0;
      fireAutoUpdaterEvent("update-downloaded", { version: "0.2.0" });
      const evt = lastSentEvent();
      expect(evt.state).toBe("downloaded-pending");
      expect(evt.version).toBe("0.2.0");
      expect(evt.requiresUserAction).toBe(true);
    });
  });

  describe("downloaded-pending transition", () => {
    it("emits downloaded-pending with requiresUserAction:true after update-downloaded", () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      mockSentEvents.length = 0;
      fireAutoUpdaterEvent("update-downloaded", { version: "0.2.0" });
      const evt = lastSentEvent();
      expect(evt.type).toBe("downloaded-pending");
      expect(evt.version).toBe("0.2.0");
      expect(evt.requiresUserAction).toBe(true);
    });
  });

  describe("installAndRestart with busy tracker", () => {
    it("emits blocked-by-busy-state when busy tracker is active", () => {
      const busyTracker = createBusyTracker();
      busyTracker.begin("sale", "Active sale");
      registerUpdaterIpc(enabledGitHubConfig(), wc, busyTracker);

      fireAutoUpdaterEvent("update-downloaded", { version: "0.2.0" });
      mockSentEvents.length = 0;

      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.INSTALL_AND_RESTART);
      const result = handler!();
      expect(result.state).toBe("blocked-by-busy-state");
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();

      const evt = lastSentEvent();
      expect(evt.type).toBe("blocked-by-busy-state");
      expect(evt.busy).toBe(true);
      expect(evt.busyReasons).toContain("sale");
    });

    it("emits error when no update has been downloaded", () => {
      const busyTracker = createBusyTracker();
      registerUpdaterIpc(enabledGitHubConfig(), wc, busyTracker);
      mockSentEvents.length = 0;

      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.INSTALL_AND_RESTART);
      const result = handler!();
      expect(result.state).toBe("error");
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });
  });

  describe("installAndRestart when idle", () => {
    it("calls quitAndInstall when idle and update is downloaded", () => {
      const busyTracker = createBusyTracker();
      registerUpdaterIpc(enabledGitHubConfig(), wc, busyTracker);

      fireAutoUpdaterEvent("update-downloaded", { version: "0.2.0" });
      mockSentEvents.length = 0;

      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.INSTALL_AND_RESTART);
      const result = handler!();
      expect(result.state).toBe("installing");
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);

      const evt = lastSentEvent();
      expect(evt.type).toBe("installing");
    });

    it("returns error state when quitAndInstall throws synchronously", () => {
      mockAutoUpdater.quitAndInstall.mockImplementation(() => {
        throw new Error("ENOSPC");
      });
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      fireAutoUpdaterEvent("update-downloaded", { version: "0.2.0" });
      mockSentEvents.length = 0;

      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.INSTALL_AND_RESTART);
      const result = handler!();

      expect(result).toEqual({ state: "error" });
      expect(lastSentEvent()).toEqual(
        expect.objectContaining({ type: "error", message: "ENOSPC" }),
      );
    });
  });

  describe("deferred install resume", () => {
    it("calls quitAndInstall when busy tracker transitions to idle after deferred install", () => {
      const busyTracker = createBusyTracker();
      const token = busyTracker.begin("sale", "Active sale");
      registerUpdaterIpc(enabledGitHubConfig(), wc, busyTracker);

      fireAutoUpdaterEvent("update-downloaded", { version: "0.2.0" });
      const installHandler = mockIpcHandlers.get(UPDATE_CHANNELS.INSTALL_AND_RESTART);
      installHandler!();
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
      expect(lastSentEvent().type).toBe("blocked-by-busy-state");

      mockSentEvents.length = 0;
      busyTracker.end(token);

      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
      expect(lastSentEvent().type).toBe("installing");
    });

    it("does not install on idle transition when no deferred install is pending", () => {
      const busyTracker = createBusyTracker();
      const token = busyTracker.begin("sale", "Active sale");
      registerUpdaterIpc(enabledGitHubConfig(), wc, busyTracker);
      mockAutoUpdater.quitAndInstall.mockReset();
      mockSentEvents.length = 0;

      busyTracker.end(token);

      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("emits error when autoUpdater emits error", () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      mockSentEvents.length = 0;
      fireAutoUpdaterEvent("error", new Error("network error"));
      const evt = lastSentEvent();
      expect(evt.type).toBe("error");
      expect(evt.message).toBe("network error");
    });

    it("emits disabled when installAndRestart is called with updates disabled", () => {
      registerUpdaterIpc(configWithUpdates({ enabled: false }), wc);
      mockSentEvents.length = 0;
      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.INSTALL_AND_RESTART);
      const result = handler!();
      expect(result.state).toBe("disabled");
      expect(mockAutoUpdater.quitAndInstall).not.toHaveBeenCalled();
    });
  });

  describe("state transitions via autoUpdater events", () => {
    it("emits checking when checking-for-update fires", () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      mockSentEvents.length = 0;
      fireAutoUpdaterEvent("checking-for-update");
      expect(lastSentEvent().type).toBe("checking");
    });

    it("emits available with version when update-available fires", () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      mockSentEvents.length = 0;
      fireAutoUpdaterEvent("update-available", { version: "0.3.0" });
      const evt = lastSentEvent();
      expect(evt.type).toBe("available");
      expect(evt.version).toBe("0.3.0");
    });

    it("emits up-to-date when update-not-available fires", () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      mockSentEvents.length = 0;
      fireAutoUpdaterEvent("update-not-available");
      expect(lastSentEvent().type).toBe("up-to-date");
    });

    it("emits download-progress with percent", () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      mockSentEvents.length = 0;
      fireAutoUpdaterEvent("download-progress", { percent: 45 });
      const evt = lastSentEvent();
      expect(evt.type).toBe("download-progress");
      expect(evt.percent).toBe(45);
    });
  });

  describe("without busy tracker", () => {
    it("still allows installAndRestart when update is downloaded", () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc, undefined);
      fireAutoUpdaterEvent("update-downloaded", { version: "0.2.0" });
      mockSentEvents.length = 0;

      const handler = mockIpcHandlers.get(UPDATE_CHANNELS.INSTALL_AND_RESTART);
      const result = handler!();
      expect(result.state).toBe("installing");
      expect(mockAutoUpdater.quitAndInstall).toHaveBeenCalled();
    });
  });

  describe("handler lifecycle", () => {
    it("removes updater handlers before re-registering them", () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      const initialHandleCalls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.length;

      registerUpdaterIpc(enabledGitHubConfig(), wc);

      expect((ipcMain.removeHandler as ReturnType<typeof vi.fn>).mock.calls).toEqual(
        expect.arrayContaining([
          [UPDATE_CHANNELS.GET_STATUS],
          [UPDATE_CHANNELS.CHECK],
          [UPDATE_CHANNELS.DOWNLOAD],
          [UPDATE_CHANNELS.INSTALL_AND_RESTART],
        ]),
      );
      expect((ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
        initialHandleCalls * 2,
      );
    });

    it("can unregister updater handlers explicitly", () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc);

      unregisterUpdaterIpc();

      expect(mockIpcHandlers.has(UPDATE_CHANNELS.GET_STATUS)).toBe(false);
      expect(mockIpcHandlers.has(UPDATE_CHANNELS.CHECK)).toBe(false);
      expect(mockIpcHandlers.has(UPDATE_CHANNELS.DOWNLOAD)).toBe(false);
      expect(mockIpcHandlers.has(UPDATE_CHANNELS.INSTALL_AND_RESTART)).toBe(false);
    });
  });

  describe("review correction coverage", () => {
    let reporter: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      resetMocks();
      wc = mockWebContents();
      reporter = vi.fn();
    });

    afterEach(() => {
      setUpdaterErrorReporter(undefined);
    });

    it.each([
      ["GitHub", { enabled: true, provider: "github", owner: "acme", repo: "my-app", allowDowngrade: true }, true],
      ["generic", { enabled: true, provider: "generic", url: "https://updates.example.com/", allowDowngrade: true }, true],
      ["default", { enabled: true, provider: "github", owner: "acme", repo: "my-app" }, false],
    ] as const)("sets autoUpdater.allowDowngrade for %s config", (_label, updates, expected) => {
      registerUpdaterIpc(configWithUpdates(updates), wc);
      expect(mockAutoUpdater.allowDowngrade).toBe(expected);
    });

    it("reports autoUpdater error events and still notifies the renderer", () => {
      setUpdaterErrorReporter(reporter);
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      fireAutoUpdaterEvent("error", new Error("network error"));

      expect(reporter).toHaveBeenCalledWith(expect.objectContaining({ phase: "check-download" }));
      expect(lastSentEvent()).toEqual(expect.objectContaining({ type: "error", message: "network error" }));
    });

    it("reports immediate and deferred install failures", () => {
      setUpdaterErrorReporter(reporter);
      mockAutoUpdater.quitAndInstall.mockImplementation(() => {
        throw new Error("ENOSPC");
      });
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      fireAutoUpdaterEvent("update-downloaded", { version: "0.2.0" });
      mockIpcHandlers.get(UPDATE_CHANNELS.INSTALL_AND_RESTART)!();

      const busyTracker = createBusyTracker();
      const token = busyTracker.begin("sale", "Active sale");
      resetMocks();
      wc = mockWebContents();
      reporter = vi.fn();
      setUpdaterErrorReporter(reporter);
      mockAutoUpdater.quitAndInstall.mockImplementation(() => {
        throw new Error("EACCES");
      });
      registerUpdaterIpc(enabledGitHubConfig(), wc, busyTracker);
      fireAutoUpdaterEvent("update-downloaded", { version: "0.2.0" });
      mockIpcHandlers.get(UPDATE_CHANNELS.INSTALL_AND_RESTART)!();
      busyTracker.end(token);

      expect(reporter).toHaveBeenCalledWith(expect.objectContaining({ phase: "install" }));
    });

    it.each([
      [UPDATE_CHANNELS.CHECK, "checkForUpdates", "ENOTFOUND"],
      [UPDATE_CHANNELS.DOWNLOAD, "downloadUpdate", "ECONNRESET"],
    ] as const)("reports rejected %s handler", async (channel, method, message) => {
      setUpdaterErrorReporter(reporter);
      mockAutoUpdater[method].mockRejectedValue(new Error(message));
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      mockSentEvents.length = 0;

      await expect(mockIpcHandlers.get(channel)!()).resolves.toEqual({ state: "error" });
      expect(reporter).toHaveBeenCalledWith(expect.objectContaining({ phase: "check-download" }));
      expect(lastSentEvent()).toEqual(expect.objectContaining({ type: "error", message }));
    });

    it("keeps no-reporter paths safe", async () => {
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      expect(() => fireAutoUpdaterEvent("error", new Error("event crash"))).not.toThrow();

      resetMocks();
      wc = mockWebContents();
      mockAutoUpdater.checkForUpdates.mockRejectedValue(new Error("promise crash"));
      registerUpdaterIpc(enabledGitHubConfig(), wc);
      await expect(mockIpcHandlers.get(UPDATE_CHANNELS.CHECK)!()).resolves.toEqual({ state: "error" });
    });
  });
});
