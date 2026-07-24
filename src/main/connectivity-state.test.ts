import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  getDatabasePath,
  openDatabase,
  closeDatabase,
  runMigrations,
} from "./db";

// ---------------------------------------------------------------------------
// Dynamic import — the module under test does not exist yet (RED phase).
// ---------------------------------------------------------------------------
let connectivityState: typeof import("./connectivity-state") | null = null;

async function loadConnectivityState() {
  if (!connectivityState) {
    connectivityState = await import("./connectivity-state");
  }
  return connectivityState;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-conn-test-"));
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("connectivity-state (RED — module not yet created)", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
  });

  afterEach(() => {
    try {
      closeDatabase(db);
    } catch {
      // already closed
    }
    cleanup(dir);
  });

  describe("ConnectivityState type", () => {
    it("accepts 'unknown' as initial state", async () => {
      // Test that the value is acceptable
      const state: import("./connectivity-state").ConnectivityState = "unknown";
      expect(state).toBe("unknown");
    });

    it("accepts 'online' as a valid state", async () => {
      const state: import("./connectivity-state").ConnectivityState = "online";
      expect(state).toBe("online");
    });

    it("accepts 'offline' as a valid state", async () => {
      const state: import("./connectivity-state").ConnectivityState = "offline";
      expect(state).toBe("offline");
    });

    it("accepts 'reconnecting' as a valid state", async () => {
      const state: import("./connectivity-state").ConnectivityState = "reconnecting";
      expect(state).toBe("reconnecting");
    });
  });

  describe("connectivity state transitions", () => {
    it("initial state is 'unknown'", async () => {
      const cs = await loadConnectivityState();
      const state = cs.getConnectivityState();
      expect(state).toBe("unknown");
    });

    it("transitions from unknown to offline", async () => {
      const cs = await loadConnectivityState();
      cs.setConnectivityState("offline");
      expect(cs.getConnectivityState()).toBe("offline");
    });

    it("transitions from unknown to online", async () => {
      const cs = await loadConnectivityState();
      cs.setConnectivityState("online");
      expect(cs.getConnectivityState()).toBe("online");
    });

    it("transitions from offline to online", async () => {
      const cs = await loadConnectivityState();
      cs.setConnectivityState("offline");
      cs.setConnectivityState("online");
      expect(cs.getConnectivityState()).toBe("online");
    });

    it("transitions from online to offline", async () => {
      const cs = await loadConnectivityState();
      cs.setConnectivityState("online");
      cs.setConnectivityState("offline");
      expect(cs.getConnectivityState()).toBe("offline");
    });

    it("transitions from online to reconnecting (degraded detection)", async () => {
      const cs = await loadConnectivityState();
      cs.setConnectivityState("online");
      cs.setConnectivityState("reconnecting");
      expect(cs.getConnectivityState()).toBe("reconnecting");
    });

    it("transitions from reconnecting back to online", async () => {
      const cs = await loadConnectivityState();
      cs.setConnectivityState("reconnecting");
      cs.setConnectivityState("online");
      expect(cs.getConnectivityState()).toBe("online");
    });

    it("transitions from reconnecting to offline", async () => {
      const cs = await loadConnectivityState();
      cs.setConnectivityState("reconnecting");
      cs.setConnectivityState("offline");
      expect(cs.getConnectivityState()).toBe("offline");
    });

    it("allows the full unknown -> offline -> online -> reconnecting cycle", async () => {
      const cs = await loadConnectivityState();
      // Reset to ensure a clean start regardless of previous tests
      cs.resetConnectivityState();
      expect(cs.getConnectivityState()).toBe("unknown");

      cs.setConnectivityState("offline");
      expect(cs.getConnectivityState()).toBe("offline");

      cs.setConnectivityState("online");
      expect(cs.getConnectivityState()).toBe("online");

      cs.setConnectivityState("reconnecting");
      expect(cs.getConnectivityState()).toBe("reconnecting");
    });
  });

  describe("connectivity state integration with OfflineState", () => {
    it("getOfflineState should accept an externally supplied connectivity state", async () => {
      const {
        getOfflineState,
      } = await import("./offline-state");

      const state = getOfflineState(db);
      // Default is 'unknown' when no connectivity is injected
      expect(state.connectivity).toBe("unknown");
    });

    it("a connectivity-aware getOfflineState variant can merge connectivity from the monitor", async () => {
      const cs = await loadConnectivityState();
      cs.setConnectivityState("offline");

      const {
        getOfflineState,
      } = await import("./offline-state");

      const state = getOfflineState(db);
      // The base function still returns 'unknown' by default; the merge
      // is done by the IPC handler or a higher-level wrapper.
      // This test verifies the shape is compatible.
      expect(["unknown", "online", "offline", "reconnecting"]).toContain(
        state.connectivity,
      );
    });
  });

  describe("connectivity change listeners", () => {
    beforeEach(async () => {
      const cs = await loadConnectivityState();
      cs.resetConnectivityState();
    });

    it("fires listener on state transition with correct previous and next values", async () => {
      const cs = await loadConnectivityState();
      const calls: Array<{ next: string; previous: string }> = [];

      cs.onConnectivityChange((next, previous) => {
        calls.push({ next, previous });
      });

      cs.setConnectivityState("offline");
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ next: "offline", previous: "unknown" });

      cs.setConnectivityState("online");
      expect(calls).toHaveLength(2);
      expect(calls[1]).toEqual({ next: "online", previous: "offline" });
    });

    it("does NOT fire listener when state does not change", async () => {
      const cs = await loadConnectivityState();
      let callCount = 0;

      cs.onConnectivityChange(() => {
        callCount++;
      });

      cs.setConnectivityState("online");
      expect(callCount).toBe(1);

      // Setting the same value again — no fire
      cs.setConnectivityState("online");
      expect(callCount).toBe(1);
    });

    it("does NOT fire listener for invalid state values", async () => {
      const cs = await loadConnectivityState();
      let callCount = 0;

      cs.onConnectivityChange(() => {
        callCount++;
      });

      (cs.setConnectivityState as (s: string) => void)("invalid" as string);
      expect(callCount).toBe(0);
      expect(cs.getConnectivityState()).toBe("unknown");
    });

    it("returns unsubscribe function that removes the listener", async () => {
      const cs = await loadConnectivityState();
      let callCount = 0;

      const unsubscribe = cs.onConnectivityChange(() => {
        callCount++;
      });

      cs.setConnectivityState("offline");
      expect(callCount).toBe(1);

      unsubscribe();
      cs.setConnectivityState("online");
      expect(callCount).toBe(1); // still 1 — listener removed
    });

    it("listener errors do not break state transitions", async () => {
      const cs = await loadConnectivityState();

      cs.onConnectivityChange(() => {
        throw new Error("Listener error");
      });

      // Should not throw
      cs.setConnectivityState("offline");
      expect(cs.getConnectivityState()).toBe("offline");
    });

    it("offline→online transition can be detected for reconnect sync triggering", async () => {
      const cs = await loadConnectivityState();
      const reconnects: Array<{ next: string; previous: string }> = [];

      cs.onConnectivityChange((next, previous) => {
        if (previous !== "online" && next === "online") {
          reconnects.push({ next, previous });
        }
      });

      cs.setConnectivityState("offline");
      cs.setConnectivityState("online");
      expect(reconnects).toHaveLength(1);

      cs.setConnectivityState("reconnecting");
      cs.setConnectivityState("online");
      expect(reconnects).toHaveLength(2);
    });
  });
});
