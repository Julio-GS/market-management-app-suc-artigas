import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeDatabase,
  getDatabasePath,
  openDatabase,
  runMigrations,
} from "./db";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-db-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("getDatabasePath", () => {
  it("returns a path under userData/offline/market-management.sqlite", () => {
    const userData = tempDir();
    try {
      const dbPath = getDatabasePath(userData);
      expect(dbPath).toBe(path.join(userData, "offline", "market-management.sqlite"));
    } finally {
      cleanup(userData);
    }
  });

  it("ensures the offline directory exists", () => {
    const userData = tempDir();
    try {
      getDatabasePath(userData);
      expect(fs.existsSync(path.join(userData, "offline"))).toBe(true);
    } finally {
      cleanup(userData);
    }
  });
});

describe("openDatabase", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = tempDir();
    dbPath = getDatabasePath(dir);
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("creates a SQLite database file at the expected path", () => {
    const db = openDatabase(dbPath);
    try {
      expect(fs.existsSync(dbPath)).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  it("enables WAL journal mode", () => {
    const db = openDatabase(dbPath);
    try {
      const row = db.pragma("journal_mode") as [{ journal_mode: string }];
      expect(row[0].journal_mode).toBe("wal");
    } finally {
      closeDatabase(db);
    }
  });

  it("sets a busy timeout", () => {
    const db = openDatabase(dbPath);
    try {
      // better-sqlite3 returns the busy_timeout pragma as a direct value
      const value = db.pragma("busy_timeout", { simple: true }) as number;
      expect(value).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
    }
  });

  it("can reopen an existing database for restart recovery", () => {
    const db1 = openDatabase(dbPath);
    db1.exec("CREATE TABLE IF NOT EXISTS restart_test (id INTEGER PRIMARY KEY, value TEXT);");
    db1.exec("INSERT INTO restart_test (value) VALUES ('survived-restart');");
    closeDatabase(db1);

    const db2 = openDatabase(dbPath);
    try {
      const row = db2.prepare("SELECT value FROM restart_test LIMIT 1").get() as { value: string };
      expect(row.value).toBe("survived-restart");
    } finally {
      closeDatabase(db2);
    }
  });

  it("runs integrity check successfully on a clean database", () => {
    const db = openDatabase(dbPath);
    try {
      const result = db.pragma("integrity_check") as [{ integrity_check: string }];
      expect(result[0].integrity_check).toBe("ok");
    } finally {
      closeDatabase(db);
    }
  });
});

describe("runMigrations", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = tempDir();
    dbPath = getDatabasePath(dir);
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("creates schema_migrations table on first run", () => {
    const db = openDatabase(dbPath);
    try {
      runMigrations(db);
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
        .get() as { name: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.name).toBe("schema_migrations");
    } finally {
      closeDatabase(db);
    }
  });

  it("creates the metadata table for bootstrap/offline state", () => {
    const db = openDatabase(dbPath);
    try {
      runMigrations(db);
      const row = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'")
        .get() as { name: string } | undefined;
      expect(row).toBeDefined();
      expect(row!.name).toBe("metadata");
    } finally {
      closeDatabase(db);
    }
  });

  it("is idempotent — running twice does not fail", () => {
    const db = openDatabase(dbPath);
    try {
      runMigrations(db);
      runMigrations(db);
      // no throw = pass
    } finally {
      closeDatabase(db);
    }
  });

  it("records applied migration version in schema_migrations", () => {
    const db = openDatabase(dbPath);
    try {
      runMigrations(db);
      const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[];
      expect(rows.length).toBeGreaterThan(0);
      expect(rows[0].version).toBeGreaterThan(0);
    } finally {
      closeDatabase(db);
    }
  });

  it("creates sales, sale_items, sale_payments, stock_movements, and outbox tables (migration v3)", () => {
    const db = openDatabase(dbPath);
    try {
      runMigrations(db);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as { name: string }[];
      const names = new Set(tables.map((t) => t.name));

      expect(names.has("sales")).toBe(true);
      expect(names.has("sale_items")).toBe(true);
      expect(names.has("sale_payments")).toBe(true);
      expect(names.has("stock_movements")).toBe(true);
      expect(names.has("outbox")).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  it("creates outbox with idempotency_key, status, and payload columns", () => {
    const db = openDatabase(dbPath);
    try {
      runMigrations(db);

      const cols = db
        .prepare("PRAGMA table_info('outbox')")
        .all() as { name: string }[];
      const colNames = new Set(cols.map((c) => c.name));

      expect(colNames.has("id")).toBe(true);
      expect(colNames.has("idempotency_key")).toBe(true);
      expect(colNames.has("operation_type")).toBe(true);
      expect(colNames.has("aggregate_type")).toBe(true);
      expect(colNames.has("aggregate_id")).toBe(true);
      expect(colNames.has("payload")).toBe(true);
      expect(colNames.has("status")).toBe(true);
      expect(colNames.has("attempt_count")).toBe(true);
      expect(colNames.has("last_error")).toBe(true);
      expect(colNames.has("created_at")).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });

  it("creates stock_movements with product_id, quantity, reason, and created_at", () => {
    const db = openDatabase(dbPath);
    try {
      runMigrations(db);

      const cols = db
        .prepare("PRAGMA table_info('stock_movements')")
        .all() as { name: string }[];
      const colNames = new Set(cols.map((c) => c.name));

      expect(colNames.has("id")).toBe(true);
      expect(colNames.has("product_id")).toBe(true);
      expect(colNames.has("quantity")).toBe(true);
      expect(colNames.has("reason")).toBe(true);
      expect(colNames.has("sale_id")).toBe(true);
      expect(colNames.has("created_at")).toBe(true);
    } finally {
      closeDatabase(db);
    }
  });
});
