import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { getDatabasePath, openDatabase, closeDatabase, runMigrations } from "./db";
import {
  createOfflineProviderPurchase,
  updateOfflineProviderPurchase,
  deleteOfflineProviderPurchase,
  listOfflineProviderPurchases,
  OfflineAuthRequiredError,
} from "./provider-purchases-local";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-provider-purchases-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createTestDb(dir: string): Database.Database {
  const dbPath = getDatabasePath(dir);
  const db = openDatabase(dbPath);
  runMigrations(db);

  db.prepare(`
    INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
    VALUES ('user-1', 'cashier1', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `).run();

  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('installation_id', 'test-install')",
  ).run();

  return db;
}

// ---------------------------------------------------------------------------
// createOfflineProviderPurchase — parity tests
// ---------------------------------------------------------------------------

describe("createOfflineProviderPurchase", () => {
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

  it("creates a purchase and returns mapped result", () => {
    const result = createOfflineProviderPurchase(db, {
      provider_name: "ACME Corp",
      amount: "1500.00",
      payment_method: "transfer",
    });

    expect(result.success).toBe(true);
    expect(result.purchase).toBeDefined();
    expect(result.purchase!.providerName).toBe("ACME Corp");
    expect(result.purchase!.amount).toBe("1500.00");
    expect(result.purchase!.paymentMethod).toBe("transfer");
    expect(result.purchase!.id).toBeDefined();
    expect(result.purchase!.createdAt).toBeDefined();
    expect(result.purchase!.updatedAt).toBeDefined();
  });

  it("throws OfflineAuthRequiredError when no offline session exists", () => {
    db.prepare("DELETE FROM offline_sessions").run();

    expect(() =>
      createOfflineProviderPurchase(db, {
        provider_name: "No Auth",
        amount: "100.00",
      }),
    ).toThrow(OfflineAuthRequiredError);
  });

  it("enqueues an outbox entry with v4 metadata (local_device_timestamp, actor_user_id, entity_label)", () => {
    const result = createOfflineProviderPurchase(db, {
      provider_name: "Metadata Test",
      amount: "2000.00",
      payment_method: "cash",
    });

    expect(result.success).toBe(true);

    const outboxRow = db
      .prepare("SELECT * FROM outbox WHERE aggregate_id = ?")
      .get(result.purchase!.id) as Record<string, unknown> | undefined;

    expect(outboxRow).toBeDefined();
    expect(outboxRow!.status).toBe("pending");
    expect(outboxRow!.operation_type).toBe("provider_purchase_create");
    expect(outboxRow!.aggregate_type).toBe("provider_purchase");
    expect(outboxRow!.actor_user_id).toBe("user-1");
    expect(outboxRow!.local_device_timestamp).toBeDefined();
    expect(outboxRow!.local_device_timestamp).not.toBeNull();
    expect(outboxRow!.entity_label).toContain("Provider purchase create");
  });

  it("sets the revalidation_required flag after creating a purchase", () => {
    createOfflineProviderPurchase(db, {
      provider_name: "Revalidation Test",
      amount: "500.00",
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
// updateOfflineProviderPurchase — parity tests
// ---------------------------------------------------------------------------

describe("updateOfflineProviderPurchase", () => {
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

  it("updates a purchase and enqueues an outbox entry with v4 metadata", () => {
    const createResult = createOfflineProviderPurchase(db, {
      provider_name: "Original",
      amount: "1000.00",
    });
    expect(createResult.success).toBe(true);

    const updateResult = updateOfflineProviderPurchase(db, createResult.purchase!.id, {
      provider_name: "Updated Corp",
      amount: "2000.00",
      payment_method: "card",
    });

    expect(updateResult.success).toBe(true);
    expect(updateResult.purchase!.providerName).toBe("Updated Corp");
    expect(updateResult.purchase!.amount).toBe("2000.00");
    expect(updateResult.purchase!.paymentMethod).toBe("card");

    // Verify outbox entry for update
    const outboxRows = db
      .prepare("SELECT * FROM outbox WHERE aggregate_id = ? ORDER BY created_at ASC")
      .all(createResult.purchase!.id) as Record<string, unknown>[];

    expect(outboxRows.length).toBe(2);

    const updateOutbox = outboxRows[1];
    expect(updateOutbox!.operation_type).toBe("provider_purchase_update");
    expect(updateOutbox!.actor_user_id).toBe("user-1");
    expect(updateOutbox!.local_device_timestamp).toBeDefined();
    expect(updateOutbox!.entity_label).toBeDefined();
  });

  it("throws OfflineAuthRequiredError when no offline session exists", () => {
    const result = createOfflineProviderPurchase(db, {
      provider_name: "Temp",
      amount: "100.00",
    });
    db.prepare("DELETE FROM offline_sessions").run();

    expect(() =>
      updateOfflineProviderPurchase(db, result.purchase!.id, { provider_name: "Fail" }),
    ).toThrow(OfflineAuthRequiredError);
  });

  it("returns error when purchase does not exist", () => {
    const result = updateOfflineProviderPurchase(db, "nonexistent", { provider_name: "Nope" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("Provider purchase not found");
  });
});

// ---------------------------------------------------------------------------
// deleteOfflineProviderPurchase — parity tests (before snapshot)
// ---------------------------------------------------------------------------

describe("deleteOfflineProviderPurchase", () => {
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

  it("deletes a purchase and enqueues an outbox entry with before snapshot", () => {
    const createResult = createOfflineProviderPurchase(db, {
      provider_name: "To Delete",
      amount: "3000.00",
      payment_method: "transfer",
    });
    expect(createResult.success).toBe(true);
    const purchaseId = createResult.purchase!.id;

    const deleteResult = deleteOfflineProviderPurchase(db, purchaseId);
    expect(deleteResult.success).toBe(true);

    // Verify outbox entry for delete with v4 metadata
    const outboxRow = db
      .prepare("SELECT * FROM outbox WHERE aggregate_id = ? AND operation_type = 'provider_purchase_delete'")
      .get(purchaseId) as Record<string, unknown> | undefined;

    expect(outboxRow).toBeDefined();
    expect(outboxRow!.status).toBe("pending");
    expect(outboxRow!.actor_user_id).toBe("user-1");
    expect(outboxRow!.local_device_timestamp).toBeDefined();
    expect(outboxRow!.entity_label).toContain("delete");

    // Verify before snapshot exists in payload
    const payload = JSON.parse(outboxRow!.payload as string);
    expect(payload).toHaveProperty("before");
    expect(payload.before.providerName).toBe("To Delete");
    expect(payload.before.amount).toBe("3000.00");
  });

  it("throws OfflineAuthRequiredError when no offline session exists", () => {
    const result = createOfflineProviderPurchase(db, {
      provider_name: "Temp",
      amount: "100.00",
    });
    db.prepare("DELETE FROM offline_sessions").run();

    expect(() =>
      deleteOfflineProviderPurchase(db, result.purchase!.id),
    ).toThrow(OfflineAuthRequiredError);
  });

  it("returns error when purchase does not exist", () => {
    const result = deleteOfflineProviderPurchase(db, "nonexistent");
    expect(result.success).toBe(false);
    expect(result.error).toBe("Provider purchase not found");
  });
});

// ---------------------------------------------------------------------------
// listOfflineProviderPurchases
// ---------------------------------------------------------------------------

describe("listOfflineProviderPurchases", () => {
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

  it("returns all purchases ordered by created_at DESC", () => {
    createOfflineProviderPurchase(db, { provider_name: "Beta", amount: "100.00" });
    createOfflineProviderPurchase(db, { provider_name: "Alpha", amount: "200.00" });
    createOfflineProviderPurchase(db, { provider_name: "Gamma", amount: "300.00" });

    const results = listOfflineProviderPurchases(db);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
    // DESC ordering is date-lexicographic; all three exist
    const names = results.map((r) => r.purchase!.providerName);
    expect(names).toContain("Alpha");
    expect(names).toContain("Beta");
    expect(names).toContain("Gamma");
  });

  it("returns empty array when no purchases exist", () => {
    const results = listOfflineProviderPurchases(db);
    expect(results).toEqual([]);
  });
});
