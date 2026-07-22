import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { getDatabasePath, openDatabase, closeDatabase, runMigrations } from "./db";
import {
  createOfflinePromotion,
  updateOfflinePromotion,
  deleteOfflinePromotion,
  listOfflinePromotions,
  OfflineAuthRequiredError,
  type OfflinePromotionRow,
} from "./promotions-local";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-promotions-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createTestDb(dir: string): Database.Database {
  const dbPath = getDatabasePath(dir);
  const db = openDatabase(dbPath);
  runMigrations(db);

  // Seed an offline session so auth guard passes
  db.prepare(`
    INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
    VALUES ('user-1', 'cashier1', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `).run();

  // Seed installation_id for outbox idempotency key generation
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('installation_id', 'test-install')",
  ).run();

  return db;
}

// ---------------------------------------------------------------------------
// createOfflinePromotion — parity tests
// ---------------------------------------------------------------------------

describe("createOfflinePromotion", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("creates a promotion and returns mapped result", () => {
    const result = createOfflinePromotion(db, {
      name: "Summer Sale",
      type: "percentage",
      discount_percent: 15,
      scope: "product",
    });

    expect(result.success).toBe(true);
    expect(result.promotion).toBeDefined();
    expect(result.promotion!.name).toBe("Summer Sale");
    expect(result.promotion!.type).toBe("percentage");
    expect(result.promotion!.discountPercent).toBe(15);
    expect(result.promotion!.enabled).toBe(true);
    expect(result.promotion!.id).toBeDefined();
    expect(result.promotion!.createdAt).toBeDefined();
    expect(result.promotion!.updatedAt).toBeDefined();
  });

  it("throws OfflineAuthRequiredError when no offline session exists", () => {
    // Remove the session
    db.prepare("DELETE FROM offline_sessions").run();

    expect(() =>
      createOfflinePromotion(db, {
        name: "No Auth",
        type: "percentage",
      }),
    ).toThrow(OfflineAuthRequiredError);
  });

  it("enqueues an outbox entry with v4 metadata (local_device_timestamp, actor_user_id, entity_label)", () => {
    const result = createOfflinePromotion(db, {
      name: "Metadata Test",
      type: "fixed",
      discount_percent: 10,
    });

    expect(result.success).toBe(true);

    const outboxRow = db
      .prepare("SELECT * FROM outbox WHERE aggregate_id = ?")
      .get(result.promotion!.id) as Record<string, unknown> | undefined;

    expect(outboxRow).toBeDefined();
    expect(outboxRow!.status).toBe("pending");
    expect(outboxRow!.operation_type).toBe("promotion_create");
    expect(outboxRow!.aggregate_type).toBe("promotion");
    expect(outboxRow!.actor_user_id).toBe("user-1");
    expect(outboxRow!.local_device_timestamp).toBeDefined();
    expect(outboxRow!.local_device_timestamp).not.toBeNull();
    expect(outboxRow!.entity_label).toContain("Promotion create");
  });

  it("sets the revalidation_required flag after creating a promotion", () => {
    createOfflinePromotion(db, {
      name: "Revalidation Test",
      type: "percentage",
    });

    const metaRow = db
      .prepare("SELECT value FROM metadata WHERE key = 'revalidation_required'")
      .get() as { value: string } | undefined;

    expect(metaRow).toBeDefined();
    expect(metaRow!.value).toBe("1");
  });

  it("re-exports OfflineAuthRequiredError for IPC error mapping", () => {
    expect(OfflineAuthRequiredError).toBeDefined();
    expect(new OfflineAuthRequiredError()).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// updateOfflinePromotion — parity tests
// ---------------------------------------------------------------------------

describe("updateOfflinePromotion", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("updates a promotion and enqueues an outbox entry with v4 metadata", () => {
    const createResult = createOfflinePromotion(db, {
      name: "Original Name",
      type: "percentage",
      discount_percent: 10,
    });
    expect(createResult.success).toBe(true);

    const updateResult = updateOfflinePromotion(db, createResult.promotion!.id, {
      name: "Updated Name",
      discount_percent: 25,
    });

    expect(updateResult.success).toBe(true);
    expect(updateResult.promotion!.name).toBe("Updated Name");
    expect(updateResult.promotion!.discountPercent).toBe(25);

    // Verify outbox entry for update
    const outboxRows = db
      .prepare("SELECT * FROM outbox WHERE aggregate_id = ? ORDER BY created_at ASC")
      .all(createResult.promotion!.id) as Record<string, unknown>[];

    expect(outboxRows.length).toBe(2); // create + update

    const updateOutbox = outboxRows[1];
    expect(updateOutbox!.operation_type).toBe("promotion_update");
    expect(updateOutbox!.actor_user_id).toBe("user-1");
    expect(updateOutbox!.local_device_timestamp).toBeDefined();
    expect(updateOutbox!.entity_label).toBeDefined();
  });

  it("throws OfflineAuthRequiredError when no offline session exists", () => {
    // Create first with auth, then remove session
    const result = createOfflinePromotion(db, {
      name: "Temp",
      type: "percentage",
    });
    db.prepare("DELETE FROM offline_sessions").run();

    expect(() =>
      updateOfflinePromotion(db, result.promotion!.id, { name: "Fail" }),
    ).toThrow(OfflineAuthRequiredError);
  });

  it("returns error when promotion does not exist", () => {
    const result = updateOfflinePromotion(db, "nonexistent", { name: "Nope" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Promotion not found");
  });
});

// ---------------------------------------------------------------------------
// deleteOfflinePromotion — parity tests (before snapshot)
// ---------------------------------------------------------------------------

describe("deleteOfflinePromotion", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("deletes a promotion and enqueues an outbox entry with before snapshot", () => {
    const createResult = createOfflinePromotion(db, {
      name: "To Delete",
      type: "percentage",
      discount_percent: 20,
      scope: "global",
    });
    expect(createResult.success).toBe(true);
    const promoId = createResult.promotion!.id;

    const deleteResult = deleteOfflinePromotion(db, promoId);
    expect(deleteResult.success).toBe(true);

    // Verify outbox entry for delete with v4 metadata
    const outboxRow = db
      .prepare("SELECT * FROM outbox WHERE aggregate_id = ? AND operation_type = 'promotion_delete'")
      .get(promoId) as Record<string, unknown> | undefined;

    expect(outboxRow).toBeDefined();
    expect(outboxRow!.status).toBe("pending");
    expect(outboxRow!.actor_user_id).toBe("user-1");
    expect(outboxRow!.local_device_timestamp).toBeDefined();
    expect(outboxRow!.entity_label).toContain("delete");

    // Verify before snapshot exists in payload
    const payload = JSON.parse(outboxRow!.payload as string);
    expect(payload).toHaveProperty("before");
    expect(payload.before.name).toBe("To Delete");
    expect(payload.before.type).toBe("percentage");
  });

  it("throws OfflineAuthRequiredError when no offline session exists", () => {
    const result = createOfflinePromotion(db, { name: "Temp", type: "percentage" });
    db.prepare("DELETE FROM offline_sessions").run();

    expect(() =>
      deleteOfflinePromotion(db, result.promotion!.id),
    ).toThrow(OfflineAuthRequiredError);
  });

  it("returns error when promotion does not exist", () => {
    const result = deleteOfflinePromotion(db, "nonexistent");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Promotion not found");
  });
});

// ---------------------------------------------------------------------------
// listOfflinePromotions
// ---------------------------------------------------------------------------

describe("listOfflinePromotions", () => {
  let dir: string;
  let db: Database.Database;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("returns all promotions ordered by name ASC", () => {
    createOfflinePromotion(db, { name: "Beta Sale", type: "percentage" });
    createOfflinePromotion(db, { name: "Alpha Sale", type: "fixed" });
    createOfflinePromotion(db, { name: "Gamma Sale", type: "percentage", discount_percent: 30 });

    const results = listOfflinePromotions(db);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    const names = results.map((r) => r.promotion!.name);
    expect(names).toEqual(["Alpha Sale", "Beta Sale", "Gamma Sale"]);
  });

  it("returns empty array when no promotions exist", () => {
    const results = listOfflinePromotions(db);
    expect(results).toEqual([]);
  });
});
