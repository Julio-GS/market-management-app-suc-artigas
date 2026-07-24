// ---------------------------------------------------------------------------
// Revalidation flag helpers
//
// Extracted from src/main/sync-engine.ts — SQL preserved verbatim.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";

const META_REVALIDATE = "revalidation_required";

/**
 * Mark that auth revalidation is required before the next privileged sync.
 */
export function markRevalidateRequired(db: Database.Database): void {
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, '1')",
  ).run(META_REVALIDATE);
}

/**
 * Clear the revalidation-required flag after successful revalidation.
 */
export function clearRevalidateRequired(db: Database.Database): void {
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, '0')",
  ).run(META_REVALIDATE);
}

/**
 * Check whether auth revalidation is required before sync.
 */
export function isRevalidationRequired(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(META_REVALIDATE) as { value: string } | undefined;
  return row?.value === "1";
}
