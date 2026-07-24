import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  markRevalidateRequired,
  clearRevalidateRequired,
  isRevalidationRequired,
} from "./revalidation-flags";

// ---------------------------------------------------------------------------
// Slice 2 RED — this test must FAIL because revalidation-flags.ts does not
// exist yet.
// ---------------------------------------------------------------------------

// We use a mock-like minimal object for the pure-flag tests.
// The actual helpers talk to better-sqlite3, so we need a real temp DB.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function tempDb(): Database.Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv-test-"));
  const dbPath = path.join(dir, "test.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)");
  return db;
}

describe("revalidation-flags", () => {
  it("markRevalidateRequired sets the flag to '1'", () => {
    const db = tempDb();
    markRevalidateRequired(db);
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'revalidation_required'").get() as { value: string } | undefined;
    expect(row?.value).toBe("1");
  });

  it("isRevalidationRequired returns true after marking", () => {
    const db = tempDb();
    markRevalidateRequired(db);
    expect(isRevalidationRequired(db)).toBe(true);
  });

  it("isRevalidationRequired returns false when not marked", () => {
    const db = tempDb();
    expect(isRevalidationRequired(db)).toBe(false);
  });

  it("clearRevalidateRequired sets the flag to '0'", () => {
    const db = tempDb();
    markRevalidateRequired(db);
    clearRevalidateRequired(db);
    const row = db.prepare("SELECT value FROM metadata WHERE key = 'revalidation_required'").get() as { value: string } | undefined;
    expect(row?.value).toBe("0");
  });

  it("isRevalidationRequired returns false after clear", () => {
    const db = tempDb();
    markRevalidateRequired(db);
    clearRevalidateRequired(db);
    expect(isRevalidationRequired(db)).toBe(false);
  });
});
