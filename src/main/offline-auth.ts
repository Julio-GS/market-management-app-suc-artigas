import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OfflineSession {
  user_id: string;
  username: string;
  last_validated_at: string;
  created_at: string;
  updated_at: string;
  password_hash?: string | null;
}

export interface OfflineLoginResult {
  success: true;
  userId: string;
  username: string;
  /** True when the login was verified locally (no network). */
  offlineMode: boolean;
}

export interface OfflineLoginFailure {
  success: false;
  error: string;
}

// ---------------------------------------------------------------------------
// Password hashing (Node crypto - no extra deps)
// ---------------------------------------------------------------------------

/**
 * Hash a plaintext password using scrypt with a random salt.
 * Returns a `{salt}:{hash}` string safe to store in SQLite.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

/**
 * Constant-time comparison of a plaintext password against a stored hash.
 */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const colonIdx = stored.indexOf(":");
    if (colonIdx === -1) return false;
    const salt = stored.slice(0, colonIdx);
    const storedHash = Buffer.from(stored.slice(colonIdx + 1), "hex");
    const inputHash = scryptSync(password, salt, 64);
    return storedHash.length === inputHash.length && timingSafeEqual(storedHash, inputHash);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session queries
// ---------------------------------------------------------------------------

/**
 * Return the cached offline session for the most recent user login on this
 * device. Returns `null` when no user has ever logged in.
 */
export function getOfflineSession(db: Database.Database): OfflineSession | null {
  const row = db
    .prepare(
      `SELECT user_id, username, last_validated_at, created_at, updated_at, password_hash
       FROM offline_sessions
       ORDER BY last_validated_at DESC, updated_at DESC, created_at DESC, user_id DESC
       LIMIT 1`,
    )
    .get() as OfflineSession | undefined;
  return row ?? null;
}

/**
 * Look up an offline session by username.
 */
export function getOfflineSessionByUsername(
  db: Database.Database,
  username: string,
): OfflineSession | null {
  const row = db
    .prepare(
      `SELECT user_id, username, last_validated_at, created_at, updated_at, password_hash
       FROM offline_sessions
       WHERE username = ?
       ORDER BY last_validated_at DESC
       LIMIT 1`,
    )
    .get(username) as OfflineSession | undefined;
  return row ?? null;
}

/**
 * Upsert an offline session, storing the hashed password so future offline
 * logins can be validated without network.
 */
export function upsertOfflineSession(
  db: Database.Database,
  userId: string,
  username: string,
  passwordHash: string,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO offline_sessions
       (user_id, username, last_validated_at, created_at, updated_at, password_hash)
     VALUES
       (@user_id, @username, @now, @now, @now, @password_hash)
     ON CONFLICT(user_id) DO UPDATE SET
       username            = excluded.username,
       last_validated_at   = excluded.last_validated_at,
       updated_at          = excluded.updated_at,
       password_hash       = excluded.password_hash`,
  ).run({ user_id: userId, username, now, password_hash: passwordHash });
}

// ---------------------------------------------------------------------------
// Default admin seeding
// ---------------------------------------------------------------------------

/**
 * Seed a default admin user into `offline_sessions` on first launch.
 * Idempotent: does nothing if a session for that username already exists with a hash.
 */
export function seedDefaultAdmin(
  db: Database.Database,
  username: string,
  password: string,
): void {
  const existing = getOfflineSessionByUsername(db, username);
  if (existing) {
    if (!existing.password_hash) {
      const hash = hashPassword(password);
      const now = new Date().toISOString();
      db.prepare(
        `UPDATE offline_sessions SET password_hash = @hash, updated_at = @now WHERE username = @username`,
      ).run({ hash, now, username });
    }
    return;
  }

  const hash = hashPassword(password);
  const syntheticUserId = `local:${username}`;
  upsertOfflineSession(db, syntheticUserId, username, hash);
}

// ---------------------------------------------------------------------------
// Offline login
// ---------------------------------------------------------------------------

/**
 * Verify credentials against the locally stored password hash.
 */
export function verifyOfflineCredentials(
  db: Database.Database,
  username: string,
  password: string,
): OfflineLoginResult | OfflineLoginFailure {
  const session = getOfflineSessionByUsername(db, username);

  if (!session) {
    return {
      success: false,
      error: "No offline session found for this user. Connect to the internet and log in at least once.",
    };
  }

  if (!session.password_hash) {
    return {
      success: false,
      error: "Offline credentials not available. Connect to the internet and log in to enable offline access.",
    };
  }

  if (!verifyPassword(password, session.password_hash)) {
    return { success: false, error: "Incorrect password." };
  }

  return {
    success: true,
    userId: session.user_id,
    username: session.username,
    offlineMode: true,
  };
}

// ---------------------------------------------------------------------------
// Eligibility / attribution helpers (existing contract)
// ---------------------------------------------------------------------------

export function assertOfflineEligible(db: Database.Database): void {
  const session = getOfflineSession(db);
  if (!session) {
    throw new OfflineAuthRequiredError();
  }
}

export function getActorUserId(db: Database.Database): string | null {
  const session = getOfflineSession(db);
  return session?.user_id ?? null;
}

// ---------------------------------------------------------------------------
// Revalidation flag helpers
// ---------------------------------------------------------------------------

export function markOfflineWorkRequiresRevalidation(db: Database.Database): void {
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('revalidation_required', '1')",
  ).run();
}

export function unblockAuthEntriesAfterRevalidation(
  db: Database.Database,
  actorUserId: string,
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE outbox
    SET status = 'pending',
        updated_at = @now
    WHERE status = 'blocked_auth'
      AND actor_user_id = @actorUserId
  `).run({ now, actorUserId });

  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('revalidation_required', '0')",
  ).run();
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class OfflineAuthRequiredError extends Error {
  constructor() {
    super(
      "Offline operations require a previously authenticated session. Please log in while online first.",
    );
    this.name = "OfflineAuthRequiredError";
  }
}
