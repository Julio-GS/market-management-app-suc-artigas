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
// We import after writing tests so TypeScript/IDE can resolve the reference,
// but vitest will fail at runtime because the target module is missing.
// ---------------------------------------------------------------------------
let offlineAuth: typeof import("./offline-auth") | null = null;

async function loadOfflineAuth() {
  if (!offlineAuth) {
    offlineAuth = await import("./offline-auth");
  }
  return offlineAuth;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-auth-test-"));
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

describe("offline-auth (RED — module not yet created)", () => {
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

  describe("getOfflineSession", () => {
    it("returns the cached session when a user has previously logged in", async () => {
      // Seed an offline session
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();

      const auth = await loadOfflineAuth();
      const session = auth.getOfflineSession(db);
      expect(session).not.toBeNull();
      expect(session!.user_id).toBe("user-1");
      expect(session!.username).toBe("cashier1");
    });

    it("returns null when no session exists (never logged in)", async () => {
      const auth = await loadOfflineAuth();
      const session = auth.getOfflineSession(db);
      expect(session).toBeNull();
    });

    it("returns the most recently validated session when multiple exist", async () => {
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-2', 'cashier2', '2026-07-03T00:00:00.000Z', '2026-07-02T00:00:00.000Z', '2026-07-02T00:00:00.000Z')
      `).run();
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-3', 'cashier3', '2026-07-02T00:00:00.000Z', '2026-07-03T00:00:00.000Z', '2026-07-04T00:00:00.000Z')
      `).run();

      const auth = await loadOfflineAuth();
      const session = auth.getOfflineSession(db);
      expect(session).not.toBeNull();
      expect(session!.user_id).toBe("user-2");
      expect(session!.username).toBe("cashier2");
    });
  });

  describe("assertOfflineEligible", () => {
    it("does not throw when a cached session exists", async () => {
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();

      const auth = await loadOfflineAuth();
      expect(() => auth.assertOfflineEligible(db)).not.toThrow();
    });

    it("throws when no cached session exists", async () => {
      const auth = await loadOfflineAuth();
      expect(() => auth.assertOfflineEligible(db)).toThrow();
    });

    it("does NOT impose a maximum stale-session age", async () => {
      // Session from 3 months ago — should still be eligible
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('user-old', 'old-cashier', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')
      `).run();

      const auth = await loadOfflineAuth();
      // Must NOT throw — no stale-session age cutoff
      expect(() => auth.assertOfflineEligible(db)).not.toThrow();
    });
  });

  describe("getActorUserId", () => {
    it("returns the cached user_id from the most recently validated session", async () => {
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('actor-1', 'actor1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
      `).run();
      db.prepare(`
        INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
        VALUES ('actor-2', 'actor2', '2026-07-05T00:00:00.000Z', '2026-07-05T00:00:00.000Z', '2026-07-05T00:00:00.000Z')
      `).run();

      const auth = await loadOfflineAuth();
      const userId = auth.getActorUserId(db);
      expect(userId).toBe("actor-2");
    });

    it("returns null when no session exists", async () => {
      const auth = await loadOfflineAuth();
      const userId = auth.getActorUserId(db);
      expect(userId).toBeNull();
    });
  });

  describe("revalidation flag helpers", () => {
    it("markOfflineWorkRequiresRevalidation sets revalidation_required metadata", async () => {
      const auth = await loadOfflineAuth();
      auth.markOfflineWorkRequiresRevalidation(db);

      const row = db
        .prepare("SELECT value FROM metadata WHERE key = 'revalidation_required'")
        .get() as { value: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.value).toBe("1");
    });

    it("unblockAuthEntriesAfterRevalidation moves only the revalidated actor's blocked_auth entries to pending", async () => {
      db.prepare(`
        INSERT INTO outbox
          (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, actor_user_id, created_at, updated_at)
        VALUES
          ('out-blocked-1', 'ik:b1', 'sale_create', 'sale', 'sale-1', '{}', 'blocked_auth', 'user-1', '2026-07-01', '2026-07-01')
      `).run();
      db.prepare(`
        INSERT INTO outbox
          (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, actor_user_id, created_at, updated_at)
        VALUES
          ('out-blocked-2', 'ik:b2', 'sale_create', 'sale', 'sale-2', '{}', 'blocked_auth', 'user-2', '2026-07-01', '2026-07-01')
      `).run();
      db.prepare(`
        INSERT INTO outbox
          (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, created_at, updated_at)
        VALUES
          ('out-pending-1', 'ik:p1', 'product_create', 'product', 'prod-1', '{}', 'pending', '2026-07-01', '2026-07-01')
      `).run();

      const auth = await loadOfflineAuth();
      auth.unblockAuthEntriesAfterRevalidation(db, "user-1");

      const blocked1 = db
        .prepare("SELECT status FROM outbox WHERE id = 'out-blocked-1'")
        .get() as { status: string };
      expect(blocked1.status).toBe("pending");

      const blocked2 = db
        .prepare("SELECT status FROM outbox WHERE id = 'out-blocked-2'")
        .get() as { status: string };
      expect(blocked2.status).toBe("blocked_auth");

      const pending1 = db
        .prepare("SELECT status FROM outbox WHERE id = 'out-pending-1'")
        .get() as { status: string };
      expect(pending1.status).toBe("pending");
    });

    it("unblockAuthEntriesAfterRevalidation clears revalidation_required flag after moving entries", async () => {
      db.prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('revalidation_required', '1')",
      ).run();

      const auth = await loadOfflineAuth();
      auth.unblockAuthEntriesAfterRevalidation(db, "user-1");

      const row = db
        .prepare("SELECT value FROM metadata WHERE key = 'revalidation_required'")
        .get() as { value: string } | undefined;
      expect(row?.value === "0" || row === undefined).toBe(true);
    });
  });
});
