// ---------------------------------------------------------------------------
// Bootstrap IPC adapter tests
//
// Verifies channel constants, handler registration/unregistration, pass-through
// success paths, and legacy failure mapping.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock electron before importing the adapter
vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}));

import { ipcMain } from "electron";
import {
  BOOTSTRAP_CHANNELS,
  registerBootstrapIpc,
  unregisterBootstrapIpc,
} from "./bootstrap-ipc";
import { BootstrapService } from "../../application/bootstrap/bootstrap-service";
import type { IBootstrapRepository } from "../../domain/bootstrap/bootstrap-repository";
import type { BootstrapResult } from "../../domain/bootstrap/bootstrap";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockRepo(overrides?: Partial<IBootstrapRepository>): IBootstrapRepository {
  return {
    getStatus: vi.fn().mockReturnValue({
      status: "pending",
      ready: false,
      syncCursor: null,
    } as BootstrapResult),
    start: vi.fn().mockResolvedValue({
      status: "complete",
      ready: true,
      syncCursor: "cursor-1",
    } as BootstrapResult),
    resume: vi.fn().mockResolvedValue({
      status: "complete",
      ready: true,
      syncCursor: "cursor-2",
    } as BootstrapResult),
    ...overrides,
  };
}

function makeMockService(repo?: IBootstrapRepository): BootstrapService {
  return new BootstrapService(repo ?? makeMockRepo());
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Bootstrap IPC adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("BOOTSTRAP_CHANNELS", () => {
    it("has byte-identical channel constants matching legacy values", () => {
      expect(BOOTSTRAP_CHANNELS.BOOTSTRAP_STATUS).toBe("offline:bootstrap:status");
      expect(BOOTSTRAP_CHANNELS.BOOTSTRAP_START).toBe("offline:bootstrap:start");
      expect(BOOTSTRAP_CHANNELS.BOOTSTRAP_RESUME).toBe("offline:bootstrap:resume");
    });

    it("has exactly three channel entries", () => {
      const keys = Object.keys(BOOTSTRAP_CHANNELS);
      expect(keys).toHaveLength(3);
    });
  });

  describe("registerBootstrapIpc", () => {
    it("registers exactly three IPC handlers", () => {
      const service = makeMockService();

      registerBootstrapIpc(service);

      expect(ipcMain.handle).toHaveBeenCalledTimes(3);
    });

    it("registers the status handler on the correct channel", () => {
      const service = makeMockService();

      registerBootstrapIpc(service);

      expect(ipcMain.handle).toHaveBeenCalledWith(
        BOOTSTRAP_CHANNELS.BOOTSTRAP_STATUS,
        expect.any(Function),
      );
    });

    it("registers the start handler on the correct channel", () => {
      const service = makeMockService();

      registerBootstrapIpc(service);

      expect(ipcMain.handle).toHaveBeenCalledWith(
        BOOTSTRAP_CHANNELS.BOOTSTRAP_START,
        expect.any(Function),
      );
    });

    it("registers the resume handler on the correct channel", () => {
      const service = makeMockService();

      registerBootstrapIpc(service);

      expect(ipcMain.handle).toHaveBeenCalledWith(
        BOOTSTRAP_CHANNELS.BOOTSTRAP_RESUME,
        expect.any(Function),
      );
    });
  });

  describe("unregisterBootstrapIpc", () => {
    it("removes exactly three IPC handlers", () => {
      unregisterBootstrapIpc();

      expect(ipcMain.removeHandler).toHaveBeenCalledTimes(3);
    });

    it("removes the status handler", () => {
      unregisterBootstrapIpc();

      expect(ipcMain.removeHandler).toHaveBeenCalledWith(
        BOOTSTRAP_CHANNELS.BOOTSTRAP_STATUS,
      );
    });

    it("removes the start handler", () => {
      unregisterBootstrapIpc();

      expect(ipcMain.removeHandler).toHaveBeenCalledWith(
        BOOTSTRAP_CHANNELS.BOOTSTRAP_START,
      );
    });

    it("removes the resume handler", () => {
      unregisterBootstrapIpc();

      expect(ipcMain.removeHandler).toHaveBeenCalledWith(
        BOOTSTRAP_CHANNELS.BOOTSTRAP_RESUME,
      );
    });
  });

  describe("status handler (success path)", () => {
    it("passes through the service result unchanged", async () => {
      const expected: BootstrapResult = {
        status: "complete",
        ready: true,
        syncCursor: "cursor-1",
      };
      const repo = makeMockRepo({ getStatus: vi.fn().mockReturnValue(expected) });
      const service = makeMockService(repo);

      registerBootstrapIpc(service);

      // Extract the registered handler
      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const statusCall = calls.find(
        (c: unknown[]) => c[0] === BOOTSTRAP_CHANNELS.BOOTSTRAP_STATUS,
      ) as [string, (...args: unknown[]) => BootstrapResult];
      const handler = statusCall[1];

      const result = await handler({} as Electron.IpcMainInvokeEvent);

      expect(result).toEqual(expected);
    });
  });

  describe("status handler (failure path)", () => {
    it("returns Database unavailable on thrown error matching legacy contract", async () => {
      const repo = makeMockRepo({
        getStatus: vi.fn().mockImplementation(() => {
          throw new Error("DB crashed");
        }),
      });
      const service = makeMockService(repo);

      registerBootstrapIpc(service);

      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const statusCall = calls.find(
        (c: unknown[]) => c[0] === BOOTSTRAP_CHANNELS.BOOTSTRAP_STATUS,
      ) as [string, (...args: unknown[]) => BootstrapResult];
      const handler = statusCall[1];

      const result = await handler({} as Electron.IpcMainInvokeEvent);

      expect(result).toEqual({
        status: "failed",
        ready: false,
        syncCursor: null,
        error: "Database unavailable",
      });
    });
  });

  describe("start handler (success path)", () => {
    it("passes through the service result unchanged", async () => {
      const expected: BootstrapResult = {
        status: "complete",
        ready: true,
        syncCursor: "cursor-start",
      };
      const repo = makeMockRepo({
        start: vi.fn().mockResolvedValue(expected),
      });
      const service = makeMockService(repo);

      registerBootstrapIpc(service);

      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const startCall = calls.find(
        (c: unknown[]) => c[0] === BOOTSTRAP_CHANNELS.BOOTSTRAP_START,
      ) as [string, (...args: unknown[]) => Promise<BootstrapResult>];
      const handler = startCall[1];

      const result = await handler({} as Electron.IpcMainInvokeEvent, {
        token: "tok",
        apiBaseUrl: "http://api",
      });

      expect(result).toEqual(expected);
      expect(repo.start).toHaveBeenCalledWith("tok", "http://api");
    });
  });

  describe("start handler (failure path)", () => {
    it("returns failed with err.message matching legacy contract", async () => {
      const repo = makeMockRepo({
        start: vi.fn().mockRejectedValue(new Error("Network down")),
      });
      const service = makeMockService(repo);

      registerBootstrapIpc(service);

      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const startCall = calls.find(
        (c: unknown[]) => c[0] === BOOTSTRAP_CHANNELS.BOOTSTRAP_START,
      ) as [string, (...args: unknown[]) => Promise<BootstrapResult>];
      const handler = startCall[1];

      const result = await handler({} as Electron.IpcMainInvokeEvent, {
        token: "tok",
        apiBaseUrl: "http://api",
      });

      expect(result).toEqual({
        status: "failed",
        ready: false,
        syncCursor: null,
        error: "Network down",
      });
    });

    it("returns Bootstrap failed fallback when thrown value is not an Error", async () => {
      const repo = makeMockRepo({
        start: vi.fn().mockRejectedValue("string error"),
      });
      const service = makeMockService(repo);

      registerBootstrapIpc(service);

      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const startCall = calls.find(
        (c: unknown[]) => c[0] === BOOTSTRAP_CHANNELS.BOOTSTRAP_START,
      ) as [string, (...args: unknown[]) => Promise<BootstrapResult>];
      const handler = startCall[1];

      const result = await handler({} as Electron.IpcMainInvokeEvent, {
        token: "tok",
        apiBaseUrl: "http://api",
      });

      expect(result).toEqual({
        status: "failed",
        ready: false,
        syncCursor: null,
        error: "Bootstrap failed",
      });
    });
  });

  describe("resume handler (success path)", () => {
    it("passes through the service result unchanged", async () => {
      const expected: BootstrapResult = {
        status: "complete",
        ready: true,
        syncCursor: "cursor-resume",
      };
      const repo = makeMockRepo({
        resume: vi.fn().mockResolvedValue(expected),
      });
      const service = makeMockService(repo);

      registerBootstrapIpc(service);

      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const resumeCall = calls.find(
        (c: unknown[]) => c[0] === BOOTSTRAP_CHANNELS.BOOTSTRAP_RESUME,
      ) as [string, (...args: unknown[]) => Promise<BootstrapResult>];
      const handler = resumeCall[1];

      const result = await handler({} as Electron.IpcMainInvokeEvent, {
        token: "tok-resume",
        apiBaseUrl: "http://api-resume",
      });

      expect(result).toEqual(expected);
      expect(repo.resume).toHaveBeenCalledWith("tok-resume", "http://api-resume");
    });
  });

  describe("resume handler (failure path)", () => {
    it("returns failed with err.message matching legacy contract", async () => {
      const repo = makeMockRepo({
        resume: vi.fn().mockRejectedValue(new Error("Timeout")),
      });
      const service = makeMockService(repo);

      registerBootstrapIpc(service);

      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const resumeCall = calls.find(
        (c: unknown[]) => c[0] === BOOTSTRAP_CHANNELS.BOOTSTRAP_RESUME,
      ) as [string, (...args: unknown[]) => Promise<BootstrapResult>];
      const handler = resumeCall[1];

      const result = await handler({} as Electron.IpcMainInvokeEvent, {
        token: "tok",
        apiBaseUrl: "http://api",
      });

      expect(result).toEqual({
        status: "failed",
        ready: false,
        syncCursor: null,
        error: "Timeout",
      });
    });

    it("returns Bootstrap resume failed fallback when thrown value is not an Error", async () => {
      const repo = makeMockRepo({
        resume: vi.fn().mockRejectedValue(42),
      });
      const service = makeMockService(repo);

      registerBootstrapIpc(service);

      const calls = (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls;
      const resumeCall = calls.find(
        (c: unknown[]) => c[0] === BOOTSTRAP_CHANNELS.BOOTSTRAP_RESUME,
      ) as [string, (...args: unknown[]) => Promise<BootstrapResult>];
      const handler = resumeCall[1];

      const result = await handler({} as Electron.IpcMainInvokeEvent, {
        token: "tok",
        apiBaseUrl: "http://api",
      });

      expect(result).toEqual({
        status: "failed",
        ready: false,
        syncCursor: null,
        error: "Bootstrap resume failed",
      });
    });
  });
});
