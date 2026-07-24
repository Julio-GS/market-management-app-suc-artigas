import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, getDatabasePath, openDatabase, runMigrations } from "../../db";

// These imports will fail (RED) until the production modules exist.
import { OfflineSqliteRepository } from "./offline-sqlite-repository";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-offline-repo-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function createTestDb(dir: string) {
  const dbPath = getDatabasePath(dir);
  const db = openDatabase(dbPath);
  runMigrations(db);
  return db;
}

// ---------------------------------------------------------------------------
// getState tests
// ---------------------------------------------------------------------------

describe("OfflineSqliteRepository.getState", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("returns a valid OfflineState from a fresh DB", () => {
    const db = createTestDb(dir);
    const getDb = () => db;
    const repo = new OfflineSqliteRepository(getDb);

    const state = repo.getState();

    expect(state).toBeDefined();
    expect(typeof state.ready).toBe("boolean");
    expect(typeof state.bootstrap).toBe("string");
    expect(typeof state.connectivity).toBe("string");
    expect(typeof state.degraded).toBe("boolean");
    expect(state.bootstrap).toBe("pending");
    expect(state.degraded).toBe(false);

    closeDatabase(db);
  });

  it("returns ready=true when bootstrap is complete and not degraded", () => {
    const db = createTestDb(dir);
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'complete')",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync_at', '2025-07-18T12:00:00.000Z')",
    ).run();

    const getDb = () => db;
    const repo = new OfflineSqliteRepository(getDb);
    const state = repo.getState();

    expect(state.ready).toBe(true);
    expect(state.bootstrap).toBe("complete");
    expect(state.degraded).toBe(false);
    expect(state.lastSyncAt).toBe("2025-07-18T12:00:00.000Z");

    closeDatabase(db);
  });

  it("returns degraded state when getDb throws", () => {
    const getDb = () => {
      throw new Error("DB not available");
    };
    const repo = new OfflineSqliteRepository(getDb);

    const state = repo.getState();

    expect(state.degraded).toBe(true);
    expect(state.bootstrap).toBe("failed");
    expect(state.ready).toBe(false);
    expect(state.connectivity).toBe("unknown");
  });

  it("returns degraded state when getOfflineState throws internally", () => {
    // Provide a DB that will cause getOfflineState to fail internally
    const db = createTestDb(dir);
    // Drop metadata table to trigger the code path, but getOfflineState handles
    // missing metadata gracefully. Instead, close the DB early to trigger an error.
    closeDatabase(db);

    const getDb = () => db; // db is closed, calls will throw
    const repo = new OfflineSqliteRepository(getDb);

    const state = repo.getState();

    expect(state.degraded).toBe(true);
    expect(state.bootstrap).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// getSession tests
// ---------------------------------------------------------------------------

describe("OfflineSqliteRepository.getSession", () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });

  afterEach(() => {
    cleanup(dir);
  });

  it("returns null when no session exists", () => {
    const db = createTestDb(dir);
    const getDb = () => db;
    const repo = new OfflineSqliteRepository(getDb);

    const result = repo.getSession();

    expect(result).toBeNull();

    closeDatabase(db);
  });

  it("returns session without password_hash", () => {
    const db = createTestDb(dir);
    db.prepare(`
      INSERT INTO offline_sessions
        (user_id, username, last_validated_at, created_at, updated_at, password_hash)
      VALUES
        ('user-1', 'cashier1', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 'salt:hash')
    `).run();

    const getDb = () => db;
    const repo = new OfflineSqliteRepository(getDb);

    const result = repo.getSession();

    expect(result).not.toBeNull();
    expect(result).toEqual({
      user_id: "user-1",
      username: "cashier1",
      last_validated_at: "2026-07-01T00:00:00.000Z",
      created_at: "2026-07-01T00:00:00.000Z",
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    expect(result).not.toHaveProperty("password_hash");

    closeDatabase(db);
  });

  it("returns null when getDb throws", () => {
    const getDb = () => {
      throw new Error("DB not available");
    };
    const repo = new OfflineSqliteRepository(getDb);

    const result = repo.getSession();

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// login tests
// ---------------------------------------------------------------------------

describe("OfflineSqliteRepository.login", () => {
  let dir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    dir = tempDir();
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup(dir);
    globalThis.fetch = originalFetch;
  });

  const loginParams = {
    username: "admin",
    password: "test123",
    apiBaseUrl: "http://localhost:3000/api/v1",
  };

  it("returns success on online login", async () => {
    const db = createTestDb(dir);
    const getDb = () => db;

    // Mock fetch for successful online login
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token:
          "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.abc",
      }),
    });

    const repo = new OfflineSqliteRepository(getDb);
    const result = await repo.login(loginParams);

    expect(result.success).toBe(true);
    expect(result.offlineMode).toBe(false);
    expect(result.userId).toBe("user-123");
    expect(result.username).toBe("admin");
    expect(result.token).toBe(
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.abc",
    );

    // Verify session was persisted
    const session = db
      .prepare("SELECT * FROM offline_sessions WHERE username = ?")
      .get("admin") as Record<string, unknown> | undefined;
    expect(session).toBeDefined();
    expect(session!.user_id).toBe("user-123");
    expect(session!.password_hash).toBeDefined();

    closeDatabase(db);
  });

  it("uses local:username fallback when JWT decode fails", async () => {
    const db = createTestDb(dir);
    const getDb = () => db;

    // Mock fetch with an invalid JWT (not base64url-decodable payload)
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        access_token: "header.not-valid-json.signature",
      }),
    });

    const repo = new OfflineSqliteRepository(getDb);
    const result = await repo.login(loginParams);

    expect(result.success).toBe(true);
    expect(result.userId).toBe("local:admin");

    closeDatabase(db);
  });

  it("falls back to offline credentials on network error (TypeError)", async () => {
    const db = createTestDb(dir);

    // Pre-seed offline credentials using hashPassword
    const {
      hashPassword,
      upsertOfflineSession,
    } = await import("../../offline-auth");
    const hash = hashPassword("test123");
    upsertOfflineSession(db, "local:admin", "admin", hash);

    const getDb = () => db;

    // Mock fetch to throw a TypeError (network error)
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const repo = new OfflineSqliteRepository(getDb);
    const result = await repo.login(loginParams);

    expect(result.success).toBe(true);
    expect(result.offlineMode).toBe(true);
    expect(result.userId).toBe("local:admin");
    expect(result.username).toBe("admin");

    closeDatabase(db);
  });

  it("falls back to offline credentials on AbortError", async () => {
    const db = createTestDb(dir);
    const {
      hashPassword,
      upsertOfflineSession,
    } = await import("../../offline-auth");
    const hash = hashPassword("test123");
    upsertOfflineSession(db, "local:admin", "admin", hash);

    const getDb = () => db;

    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    globalThis.fetch = vi.fn().mockRejectedValue(abortError);

    const repo = new OfflineSqliteRepository(getDb);
    const result = await repo.login(loginParams);

    expect(result.success).toBe(true);
    expect(result.offlineMode).toBe(true);

    closeDatabase(db);
  });

  it("falls back to offline credentials on TimeoutError", async () => {
    const db = createTestDb(dir);
    const {
      hashPassword,
      upsertOfflineSession,
    } = await import("../../offline-auth");
    const hash = hashPassword("test123");
    upsertOfflineSession(db, "local:admin", "admin", hash);

    const getDb = () => db;

    const timeoutError = new Error("The request timed out");
    timeoutError.name = "TimeoutError";
    globalThis.fetch = vi.fn().mockRejectedValue(timeoutError);

    const repo = new OfflineSqliteRepository(getDb);
    const result = await repo.login(loginParams);

    expect(result.success).toBe(true);
    expect(result.offlineMode).toBe(true);

    closeDatabase(db);
  });

  it("falls back to offline credentials when error message includes 'fetch'", async () => {
    const db = createTestDb(dir);
    const {
      hashPassword,
      upsertOfflineSession,
    } = await import("../../offline-auth");
    const hash = hashPassword("test123");
    upsertOfflineSession(db, "local:admin", "admin", hash);

    const getDb = () => db;

    const fetchError = new Error("Failed to fetch resource");
    globalThis.fetch = vi.fn().mockRejectedValue(fetchError);

    const repo = new OfflineSqliteRepository(getDb);
    const result = await repo.login(loginParams);

    expect(result.success).toBe(true);
    expect(result.offlineMode).toBe(true);

    closeDatabase(db);
  });

  it("does NOT fall back to offline on non-network errors", async () => {
    const db = createTestDb(dir);
    const getDb = () => db;

    const appError = new Error("Something else broke");
    appError.name = "AppError";
    globalThis.fetch = vi.fn().mockRejectedValue(appError);

    const repo = new OfflineSqliteRepository(getDb);
    const result = await repo.login(loginParams);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Something else broke");

    closeDatabase(db);
  });

  it("returns error on backend non-2xx response with message", async () => {
    const db = createTestDb(dir);
    const getDb = () => db;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: "Invalid credentials" }),
    });

    const repo = new OfflineSqliteRepository(getDb);
    const result = await repo.login(loginParams);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Invalid credentials");

    closeDatabase(db);
  });

  it("returns default error on backend non-2xx without message JSON", async () => {
    const db = createTestDb(dir);
    const getDb = () => db;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const repo = new OfflineSqliteRepository(getDb);
    const result = await repo.login(loginParams);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Login failed (500)");

    closeDatabase(db);
  });

  it("returns error on offline credential failure", async () => {
    const db = createTestDb(dir);
    const getDb = () => db;

    // Network error triggers offline fallback, but no credentials stored
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    const repo = new OfflineSqliteRepository(getDb);
    const result = await repo.login(loginParams);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();

    closeDatabase(db);
  });

  it("preserves 8-second timeout via AbortSignal.timeout", async () => {
    const db = createTestDb(dir);
    const getDb = () => db;

    let capturedSignal: AbortSignal | null | undefined;

    globalThis.fetch = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) => {
        capturedSignal = init?.signal;
        return Promise.resolve({
          ok: true,
          json: async () => ({
            access_token:
              "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMyJ9.abc",
          }),
        });
      },
    );

    const repo = new OfflineSqliteRepository(getDb);
    await repo.login(loginParams);

    // Verify AbortSignal.timeout was used (we check the signal was passed,
    // since we can't easily inspect the timeout value in tests)
    expect(capturedSignal).toBeDefined();
    expect(capturedSignal).toBeInstanceOf(AbortSignal);

    closeDatabase(db);
  });
});
