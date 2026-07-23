// ---------------------------------------------------------------------------
// Infrastructure: ReportsSqliteRepository integration tests
//
// Strict TDD RED phase: imports fail because ReportsSqliteRepository and
// domain types do not exist yet. After GREEN implementation, these tests
// verify legacy SQL, row mapping, staleness computation, and read-only
// behaviour preserved from src/main/reports-ipc.ts.
// ---------------------------------------------------------------------------

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { getDatabasePath, openDatabase, closeDatabase, runMigrations } from "../../db";

// ---- RED: these imports will fail until domain + repository are created ----
import { ReportsSqliteRepository } from "./reports-sqlite-repository";
import type { OfflineSalesSummary, OfflineRecentSale, OfflineStalenessInfo } from "../../domain/reports/report";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-reports-hex-test-"));
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
// Sales summary
// ---------------------------------------------------------------------------

describe("ReportsSqliteRepository.getSalesSummary", () => {
  let dir: string;
  let db: Database.Database;
  let repo: ReportsSqliteRepository;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
    repo = new ReportsSqliteRepository(() => db);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("returns zero-filled default with stale reason when no sales exist and no last_sync_at", () => {
    const result = repo.getSalesSummary();

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.totalSales).toBe(0);
    expect(result.data!.totalRevenue).toBe("0.00");
    expect(result.data!.periodStart).toBe("");
    expect(result.data!.periodEnd).toBe("");
    expect(result.staleness).toBe("stale");
    expect(result.stalenessReason).toBe("No data available offline. Connect to sync.");
  });

  it("returns zero-filled default with last-sync message when no sales but last_sync_at exists", () => {
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync_at', '2026-07-20T12:00:00Z')").run();

    const result = repo.getSalesSummary();

    expect(result.success).toBe(true);
    expect(result.data!.totalSales).toBe(0);
    expect(result.staleness).toBe("stale");
    expect(result.stalenessReason).toContain("No local sales found. Last synced: 2026-07-20T12:00:00Z");
  });

  it("returns count, revenue with toFixed(2), and period boundaries when sales exist", () => {
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('s1', '100.50', 'Alice', 'completed', '2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('s2', '200.75', 'Bob', 'completed', '2026-07-15T14:00:00Z', '2026-07-15T14:00:00Z')
    `).run();

    const result = repo.getSalesSummary();

    expect(result.success).toBe(true);
    expect(result.data!.totalSales).toBe(2);
    expect(result.data!.totalRevenue).toBe("301.25");
    expect(result.data!.periodStart).toBe("2026-07-01T10:00:00Z");
    expect(result.data!.periodEnd).toBe("2026-07-15T14:00:00Z");
  });

  it("returns staleness 'stale' when last_sync_at is truthy and sales exist", () => {
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync_at', '2026-07-20T12:00:00Z')").run();
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('s1', '50.00', 'Alice', 'completed', '2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z')
    `).run();

    const result = repo.getSalesSummary();

    expect(result.success).toBe(true);
    expect(result.staleness).toBe("stale");
    expect(result.stalenessReason).toContain("Last server sync: 2026-07-20T12:00:00Z");
  });

  it("returns staleness 'live' when no last_sync_at and sales exist", () => {
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('s1', '50.00', 'Alice', 'completed', '2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z')
    `).run();

    const result = repo.getSalesSummary();

    expect(result.success).toBe(true);
    expect(result.staleness).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// Recent sales — default limit, ordering, row mapping
// ---------------------------------------------------------------------------

describe("ReportsSqliteRepository.getRecentSales", () => {
  let dir: string;
  let db: Database.Database;
  let repo: ReportsSqliteRepository;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
    repo = new ReportsSqliteRepository(() => db);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("uses default limit 10 when no limit argument is passed", () => {
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('s1', '10.00', 'Alice', 'completed', '2026-07-01T08:00:00Z', '2026-07-01T08:00:00Z')
    `).run();

    const result = repo.getRecentSales();

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    // When omitted, the repository should internally default to 10
  });

  it("uses explicit limit when passed", () => {
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('s1', '10.00', 'A', 'completed', '2026-07-01T08:00:00Z', '2026-07-01T08:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('s2', '20.00', 'B', 'completed', '2026-07-02T08:00:00Z', '2026-07-02T08:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('s3', '30.00', 'C', 'completed', '2026-07-03T08:00:00Z', '2026-07-03T08:00:00Z')
    `).run();

    const result = repo.getRecentSales(2);

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(2);
  });

  it("orders by created_at DESC", () => {
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('early', '10.00', 'First', 'completed', '2026-07-01T08:00:00Z', '2026-07-01T08:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('late', '30.00', 'Last', 'completed', '2026-07-10T20:00:00Z', '2026-07-10T20:00:00Z')
    `).run();
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('mid', '20.00', 'Middle', 'completed', '2026-07-05T12:00:00Z', '2026-07-05T12:00:00Z')
    `).run();

    const result = repo.getRecentSales();

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(3);
    expect(result.data![0].id).toBe("late");
    expect(result.data![1].id).toBe("mid");
    expect(result.data![2].id).toBe("early");
  });

  it("maps invoice_status -> invoiceStatus and created_at -> createdAt", () => {
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('s1', '100.00', 'Alice', 'completed', '2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z')
    `).run();

    const result = repo.getRecentSales();

    expect(result.success).toBe(true);
    const sale = result.data![0] as OfflineRecentSale;
    expect(sale.invoiceStatus).toBe("completed");
    expect(sale.createdAt).toBe("2026-07-01T10:00:00Z");
    expect(sale.id).toBe("s1");
    expect(sale.total).toBe("100.00");
    expect(sale.customer).toBe("Alice");
  });

  it("returns staleness reason including sales.length when last_sync_at is set", () => {
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync_at', '2026-07-20T12:00:00Z')").run();
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('s1', '50.00', 'Alice', 'completed', '2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z')
    `).run();

    const result = repo.getRecentSales();

    expect(result.success).toBe(true);
    expect(result.staleness).toBe("stale");
    expect(result.stalenessReason).toContain("Showing 1 local sales");
    expect(result.stalenessReason).toContain("Last sync: 2026-07-20T12:00:00Z");
  });

  it("returns live staleness when no last_sync_at", () => {
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('s1', '50.00', 'Alice', 'completed', '2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z')
    `).run();

    const result = repo.getRecentSales();

    expect(result.success).toBe(true);
    expect(result.staleness).toBe("live");
    expect(result.stalenessReason).toContain("Connect to sync for complete history");
  });
});

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

describe("ReportsSqliteRepository.getStaleness", () => {
  let dir: string;
  let db: Database.Database;
  let repo: ReportsSqliteRepository;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
    repo = new ReportsSqliteRepository(() => db);
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("returns lastSyncAt: null, isStale: true, staleness: 'unavailable' when no last_sync_at", () => {
    const result = repo.getStaleness();

    expect(result.success).toBe(true);
    expect(result.data!.lastSyncAt).toBeNull();
    expect(result.data!.pendingCount).toBe(0);
    expect(result.data!.isStale).toBe(true);
    expect(result.staleness).toBe("unavailable");
  });

  it("returns live/not stale with truthy last_sync_at and no pending outbox", () => {
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync_at', '2026-07-20T12:00:00Z')").run();

    const result = repo.getStaleness();

    expect(result.success).toBe(true);
    expect(result.data!.lastSyncAt).toBe("2026-07-20T12:00:00Z");
    expect(result.data!.pendingCount).toBe(0);
    expect(result.data!.isStale).toBe(false);
    expect(result.staleness).toBe("live");
  });

  it("returns stale when pending outbox rows exist", () => {
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync_at', '2026-07-20T12:00:00Z')").run();
    db.prepare(`
      INSERT INTO outbox (id, idempotency_key, operation_type, aggregate_type, aggregate_id, payload, status, created_at, updated_at)
      VALUES ('out-1', 'ik-1', 'create', 'sale', 's1', '{}', 'pending', '2026-07-15T10:00:00Z', '2026-07-15T10:00:00Z')
    `).run();

    const result = repo.getStaleness();

    expect(result.success).toBe(true);
    expect(result.data!.lastSyncAt).toBe("2026-07-20T12:00:00Z");
    expect(result.data!.pendingCount).toBe(1);
    expect(result.data!.isStale).toBe(true);
    expect(result.staleness).toBe("stale");
  });
});

// ---------------------------------------------------------------------------
// Read-only behaviour
// ---------------------------------------------------------------------------

describe("ReportsSqliteRepository read-only guarantee", () => {
  let dir: string;
  let db: Database.Database;
  let repo: ReportsSqliteRepository;

  beforeEach(() => {
    dir = tempDir();
    db = createTestDb(dir);
    repo = new ReportsSqliteRepository(() => db);
    db.prepare(`
      INSERT INTO sales (id, total, customer, invoice_status, created_at, updated_at)
      VALUES ('s1', '100.00', 'Alice', 'completed', '2026-07-01T10:00:00Z', '2026-07-01T10:00:00Z')
    `).run();
  });

  afterEach(() => {
    closeDatabase(db);
    cleanup(dir);
  });

  it("does not alter sales count after report queries", () => {
    const before = (db.prepare("SELECT COUNT(*) as c FROM sales").get() as { c: number }).c;

    repo.getSalesSummary();
    repo.getRecentSales();
    repo.getStaleness();

    const after = (db.prepare("SELECT COUNT(*) as c FROM sales").get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it("does not alter metadata after report queries", () => {
    const before = (db.prepare("SELECT COUNT(*) as c FROM metadata").get() as { c: number }).c;

    repo.getSalesSummary();
    repo.getStaleness();

    const after = (db.prepare("SELECT COUNT(*) as c FROM metadata").get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it("does not alter outbox after report queries", () => {
    const before = (db.prepare("SELECT COUNT(*) as c FROM outbox").get() as { c: number }).c;

    repo.getStaleness();

    const after = (db.prepare("SELECT COUNT(*) as c FROM outbox").get() as { c: number }).c;
    expect(after).toBe(before);
  });
});
