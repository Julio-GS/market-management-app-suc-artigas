import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import {
  getOfflineState,
  INITIAL_OFFLINE_STATE,
  type OfflineState,
} from "./offline-state";
import { openDatabase, runMigrations, closeDatabase, getDatabasePath } from "./db";

// ---------------------------------------------------------------------------
// IPC handler capture — mock electron so we can test the handler function
// ---------------------------------------------------------------------------

const { capturedHandlers } = vi.hoisted(() => {
  const handlers: Record<string, (...args: unknown[]) => unknown> = {};
  return { capturedHandlers: handlers };
});

vi.mock("electron", () => ({
  ipcMain: {
    handle(channel: string, handler: (...args: unknown[]) => unknown) {
      capturedHandlers[channel] = handler;
    },
    removeHandler(channel: string) {
      delete capturedHandlers[channel];
    },
  },
}));

import {
  registerOfflineIpc,
  unregisterOfflineIpc,
  OFFLINE_CHANNELS,
} from "./adapters/offline/offline-ipc";
import { OfflineService } from "./application/offline/offline-service";
import { OfflineSqliteRepository } from "./infrastructure/persistence/offline-sqlite-repository";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-state-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Shape contract tests (fast, no DB)
// ---------------------------------------------------------------------------

function assertOfflineStateShape(state: unknown): asserts state is OfflineState {
  if (typeof state !== "object" || state === null) {
    throw new Error("OfflineState must be an object");
  }

  const s = state as Record<string, unknown>;

  const requiredKeys = [
    "ready",
    "bootstrap",
    "connectivity",
    "sync",
    "pendingCount",
    "failureCount",
    "degraded",
    "lastSyncAt",
    "statusCounts",
  ];

  for (const key of requiredKeys) {
    if (!(key in s)) {
      throw new Error(`OfflineState missing required key: ${key}`);
    }
  }

  if (typeof s.ready !== "boolean") throw new Error("ready must be boolean");
  if (typeof s.bootstrap !== "string") throw new Error("bootstrap must be string");
  if (typeof s.connectivity !== "string") throw new Error("connectivity must be string");
  if (typeof s.sync !== "string") throw new Error("sync must be string");
  if (typeof s.pendingCount !== "number") throw new Error("pendingCount must be number");
  if (typeof s.failureCount !== "number") throw new Error("failureCount must be number");
  if (typeof s.degraded !== "boolean") throw new Error("degraded must be boolean");
  // lastSyncAt may be null or string
  if (s.lastSyncAt !== null && typeof s.lastSyncAt !== "string") {
    throw new Error("lastSyncAt must be string | null");
  }

  // statusCounts shape
  if (typeof s.statusCounts !== "object" || s.statusCounts === null) {
    throw new Error("statusCounts must be an object");
  }
  const sc = s.statusCounts as Record<string, unknown>;
  const statusCountKeys = ["pending", "in_flight", "failed", "retry_wait", "blocked_auth", "blocked_conflict", "manual_fix", "synced"];
  for (const key of statusCountKeys) {
    if (typeof sc[key] !== "number") {
      throw new Error(`statusCounts.${key} must be number`);
    }
  }

  const validBootstrap = ["pending", "in_progress", "complete", "failed"];
  if (!validBootstrap.includes(s.bootstrap as string)) {
    throw new Error(`bootstrap must be one of: ${validBootstrap.join(", ")}`);
  }

  const validConnectivity = ["online", "offline", "unknown", "reconnecting"];
  if (!validConnectivity.includes(s.connectivity as string)) {
    throw new Error(`connectivity must be one of: ${validConnectivity.join(", ")}`);
  }

  const validSync = ["idle", "syncing", "error"];
  if (!validSync.includes(s.sync as string)) {
    throw new Error(`sync must be one of: ${validSync.join(", ")}`);
  }
}

function makeEmptyStatusCounts() {
  return {
    pending: 0,
    in_flight: 0,
    failed: 0,
    retry_wait: 0,
    blocked_auth: 0,
    blocked_conflict: 0,
    manual_fix: 0,
    synced: 0,
  };
}

describe("OfflineState shape contract", () => {
  it("accepts a valid initial pre-bootstrap state", () => {
    const state: OfflineState = {
      ready: false,
      bootstrap: "pending",
      connectivity: "unknown",
      sync: "idle",
      pendingCount: 0,
      failureCount: 0,
      degraded: false,
      lastSyncAt: null,
      statusCounts: makeEmptyStatusCounts(),
    };

    expect(() => assertOfflineStateShape(state)).not.toThrow();
  });

  it("accepts a bootstrapped ready state", () => {
    const state: OfflineState = {
      ready: true,
      bootstrap: "complete",
      connectivity: "online",
      sync: "idle",
      pendingCount: 0,
      failureCount: 0,
      degraded: false,
      lastSyncAt: null,
      statusCounts: makeEmptyStatusCounts(),
    };

    expect(() => assertOfflineStateShape(state)).not.toThrow();
  });

  it("accepts offline state with pending items", () => {
    const state: OfflineState = {
      ready: true,
      bootstrap: "complete",
      connectivity: "offline",
      sync: "idle",
      pendingCount: 5,
      failureCount: 1,
      degraded: false,
      lastSyncAt: "2025-07-18T00:00:00.000Z",
      statusCounts: { ...makeEmptyStatusCounts(), pending: 5, failed: 1 },
    };

    expect(() => assertOfflineStateShape(state)).not.toThrow();
  });

  it("accepts degraded state", () => {
    const state: OfflineState = {
      ready: false,
      bootstrap: "failed",
      connectivity: "unknown",
      sync: "error",
      pendingCount: 0,
      failureCount: 0,
      degraded: true,
      lastSyncAt: null,
      statusCounts: makeEmptyStatusCounts(),
    };

    expect(() => assertOfflineStateShape(state)).not.toThrow();
  });

  it("rejects an object missing required keys", () => {
    expect(() => assertOfflineStateShape({ ready: false })).toThrow();
  });

  it("rejects invalid bootstrap state value", () => {
    const state = {
      ready: false,
      bootstrap: "invalid_state",
      connectivity: "unknown",
      sync: "idle",
      pendingCount: 0,
      failureCount: 0,
      degraded: false,
      lastSyncAt: null,
      statusCounts: makeEmptyStatusCounts(),
    };

    expect(() => assertOfflineStateShape(state)).toThrow(/bootstrap/);
  });

  it("rejects wrong type for pendingCount", () => {
    const state = {
      ready: false,
      bootstrap: "pending",
      connectivity: "unknown",
      sync: "idle",
      pendingCount: "5",
      failureCount: 0,
      degraded: false,
      lastSyncAt: null,
      statusCounts: makeEmptyStatusCounts(),
    };

    expect(() => assertOfflineStateShape(state)).toThrow(/pendingCount/);
  });
});

// ---------------------------------------------------------------------------
// Production getOfflineState tests with a real SQLite DB
// ---------------------------------------------------------------------------

describe("getOfflineState with real SQLite DB", () => {
  let dir: string;
  let dbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = tempDir();
    dbPath = getDatabasePath(dir);
    db = openDatabase(dbPath);
    runMigrations(db);
  });

  afterEach(() => {
    try {
      closeDatabase(db);
    } catch {
      // already closed
    }
    cleanup(dir);
  });

  it("returns a valid OfflineState shape from the real DB after migrations", () => {
    const state = getOfflineState(db);
    // Should not throw — validates the shape contract against production output
    expect(() => assertOfflineStateShape(state)).not.toThrow();
  });

  it("returns ready=false, bootstrap=pending, degraded=false for a fresh DB", () => {
    const state = getOfflineState(db);
    expect(state.ready).toBe(false);
    expect(state.bootstrap).toBe("pending");
    expect(state.degraded).toBe(false);
    expect(state.connectivity).toBe("unknown");
    expect(state.sync).toBe("idle");
    expect(state.pendingCount).toBe(0);
    expect(state.failureCount).toBe(0);
    expect(state.lastSyncAt).toBeNull();
  });

  it("returns degraded=true when metadata.degraded is set to '1'", () => {
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('degraded', '1')",
    ).run();

    const state = getOfflineState(db);
    expect(state.degraded).toBe(true);
    expect(state.ready).toBe(false); // degraded overrides bootstrap status
  });

  it("returns ready=true when bootstrap is complete and not degraded", () => {
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'complete')",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync_at', '2025-07-18T12:00:00.000Z')",
    ).run();

    const state = getOfflineState(db);
    expect(state.ready).toBe(true);
    expect(state.bootstrap).toBe("complete");
    expect(state.degraded).toBe(false);
    expect(state.lastSyncAt).toBe("2025-07-18T12:00:00.000Z");
  });

  it("returns ready=false when bootstrap is complete but DB is degraded", () => {
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'complete')",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('degraded', '1')",
    ).run();

    const state = getOfflineState(db);
    expect(state.ready).toBe(false);
    expect(state.bootstrap).toBe("complete");
    expect(state.degraded).toBe(true);
  });

  it("returns the INITIAL_OFFLINE_STATE defaults when metadata table is missing", () => {
    // Drop the metadata table to simulate pre-migration state
    db.exec("DROP TABLE IF EXISTS metadata");

    const state = getOfflineState(db);
    expect(state.ready).toBe(false);
    expect(state.bootstrap).toBe("pending");
    expect(state.degraded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IPC handler resilience — degraded state when DB is unavailable
// ---------------------------------------------------------------------------

describe("offline IPC handler resilience", () => {
  afterEach(() => {
    // Clean up any channel handlers registered during tests
    try {
      unregisterOfflineIpc();
    } catch {
      // may not have been registered
    }
  });

  it("registers a handler on the offline:get-state channel", () => {
    const getDb = () => {
      throw new Error("DB not available");
    };
        const repo = new OfflineSqliteRepository(getDb);
        const service = new OfflineService(repo);
        registerOfflineIpc(service);

    const handler = capturedHandlers[OFFLINE_CHANNELS.GET_STATE];
    expect(handler).toBeDefined();
    expect(typeof handler).toBe("function");
  });

  it("returns a degraded OfflineState when getDb throws (DB init failure)", () => {
    const getDb = () => {
      throw new Error("DB not available");
    };
        const repo = new OfflineSqliteRepository(getDb);
        const service = new OfflineService(repo);
        registerOfflineIpc(service);

    const handler = capturedHandlers[OFFLINE_CHANNELS.GET_STATE];
    expect(handler).toBeDefined();

    const state = handler!() as OfflineState;
    expect(state.degraded).toBe(true);
    expect(state.bootstrap).toBe("failed");
    expect(state.ready).toBe(false);
    expect(state.connectivity).toBe("unknown");
  });

  it("returns a valid production state when getDb succeeds", () => {
    const dir = tempDir();
    const dbPath = getDatabasePath(dir);
    const realDb = openDatabase(dbPath);
    runMigrations(realDb);

    const getDb = () => realDb;
        const repo = new OfflineSqliteRepository(getDb);
        const service = new OfflineService(repo);
        registerOfflineIpc(service);

    const handler = capturedHandlers[OFFLINE_CHANNELS.GET_STATE];
    expect(handler).toBeDefined();

    const state = handler!() as OfflineState;
    expect(() => assertOfflineStateShape(state)).not.toThrow();
    expect(state.degraded).toBe(false);
    expect(state.bootstrap).toBe("pending");

    closeDatabase(realDb);
    cleanup(dir);
    unregisterOfflineIpc();
  });

  it("unregisterOfflineIpc removes the handler", () => {
    const getDb = () => {
      throw new Error("n/a");
    };
        const repo = new OfflineSqliteRepository(getDb);
        const service = new OfflineService(repo);
        registerOfflineIpc(service);
    expect(capturedHandlers[OFFLINE_CHANNELS.GET_STATE]).toBeDefined();

    unregisterOfflineIpc();
    expect(capturedHandlers[OFFLINE_CHANNELS.GET_STATE]).toBeUndefined();
  });
});
