import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn((channel: string) => {
        handlers.delete(channel);
      }),
      _handlers: handlers,
    },
  };
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import { closeDatabase, getDatabasePath, openDatabase, runMigrations } from "./db";
import {
  OFFLINE_CHANNELS,
  registerOfflineIpc,
  toOfflineSessionIpcResult,
  unregisterOfflineIpc,
} from "./offline-ipc";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-offline-ipc-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createTestDb(dir: string): Database.Database {
  const dbPath = getDatabasePath(dir);
  const db = openDatabase(dbPath);
  runMigrations(db);
  return db;
}

function getHandler(channel: string): (...args: unknown[]) => unknown {
  const mockIpc = ipcMain as unknown as {
    _handlers: Map<string, (...args: unknown[]) => unknown>;
  };
  const handler = mockIpc._handlers.get(channel);
  if (!handler) throw new Error(`Handler not found for channel: ${channel}`);
  return handler;
}

describe("offline-ipc", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
  });

  afterEach(() => {
    try {
      unregisterOfflineIpc();
    } catch {
      // already removed
    }
    closeDatabase(db);
    cleanup(dir);
    vi.clearAllMocks();
  });

  it("strips password_hash from offline:get-session responses", () => {
    db.prepare(`
      INSERT INTO offline_sessions
        (user_id, username, last_validated_at, created_at, updated_at, password_hash)
      VALUES
        ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 'salt:hash')
    `).run();

    registerOfflineIpc(() => db);
    const handler = getHandler(OFFLINE_CHANNELS.GET_SESSION);

    const result = handler() as Record<string, unknown> | null;

    expect(result).toEqual({
      user_id: "user-1",
      username: "cashier1",
      last_validated_at: "2026-07-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    expect(result).not.toHaveProperty("password_hash");
  });

  it("strips password_hash without mutating the stored session object", () => {
    const session = {
      user_id: "user-1",
      username: "cashier1",
      last_validated_at: "2026-07-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
      password_hash: "salt:hash",
    };

    const result = toOfflineSessionIpcResult(session);

    expect(result).not.toHaveProperty("password_hash");
    expect(session.password_hash).toBe("salt:hash");
  });
});
