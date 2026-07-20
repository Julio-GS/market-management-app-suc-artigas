import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { openDatabase, closeDatabase, runMigrations } from "./db";
import { getOfflineState } from "./offline-state";
import {
  startBootstrap,
  resumeBootstrap,
  getBootstrapStatus,
  ingestBootstrapSnapshot,
  type BootstrapSnapshot,
} from "./bootstrap";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_BACKEND_URL = "http://localhost:9999";

function createTestDb(): Database.Database {
  // Use an in-memory DB for fast tests
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  runMigrations(db);
  return db;
}

function makeSnapshot(overrides?: Partial<BootstrapSnapshot>): BootstrapSnapshot {
  return {
    products: [],
    stock_balances: [],
    promotions: [],
    provider_purchases: [],
    user_profile: { id: "u1", username: "cashier", created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z" },
    sync_cursor: "2024-01-15T12:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("bootstrap", () => {
  describe("getBootstrapStatus", () => {
    it("returns pending when no bootstrap data exists", () => {
      const db = createTestDb();
      const status = getBootstrapStatus(db);
      expect(status.status).toBe("pending");
      expect(status.ready).toBe(false);
      db.close();
    });

    it("returns complete and ready after successful ingestion", () => {
      const db = createTestDb();
      const snapshot = makeSnapshot();

      ingestBootstrapSnapshot(db, snapshot);

      const status = getBootstrapStatus(db);
      expect(status.status).toBe("complete");
      expect(status.ready).toBe(true);
      expect(status.syncCursor).toBe("2024-01-15T12:00:00.000Z");
      db.close();
    });

    it("returns in_progress when bootstrap was started but not completed", () => {
      const db = createTestDb();
      // Simulate in_progress state by setting metadata directly
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'in_progress')").run();

      const status = getBootstrapStatus(db);
      expect(status.status).toBe("in_progress");
      expect(status.ready).toBe(false);
      db.close();
    });

    it("returns failed when bootstrap was marked failed", () => {
      const db = createTestDb();
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'failed')").run();

      const status = getBootstrapStatus(db);
      expect(status.status).toBe("failed");
      expect(status.ready).toBe(false);
      db.close();
    });
  });

  describe("ingestBootstrapSnapshot", () => {
    it("persists products into the local store", () => {
      const db = createTestDb();
      const snapshot = makeSnapshot({
        products: [
          {
            id: "p-1",
            detalle: "Test Product",
            costo_neto: "10.00",
            costo_final: "12.10",
            iva: "21.00",
            cambio_costo: "fixed",
            cambio_precio: "fixed",
            etiqueta: "Test",
            facturable: true,
            maneja_stock: true,
            codigos: ["123"],
            pricing_mode: "fixed",
            is_protected: false,
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      });

      ingestBootstrapSnapshot(db, snapshot);

      const products = db.prepare("SELECT * FROM products").all();
      expect(products).toHaveLength(1);
      expect((products as { id: string }[])[0].id).toBe("p-1");
      db.close();
    });

    it("persists stock balances into the local store", () => {
      const db = createTestDb();
      const snapshot = makeSnapshot({
        stock_balances: [
          { product_id: "p-1", stock_actual: 50, updated_at: "2024-01-02T00:00:00.000Z" },
        ],
      });

      ingestBootstrapSnapshot(db, snapshot);

      const balances = db.prepare("SELECT * FROM stock_balances").all();
      expect(balances).toHaveLength(1);
      expect((balances as { product_id: string }[])[0].product_id).toBe("p-1");
      db.close();
    });

    it("persists promotions into the local store", () => {
      const db = createTestDb();
      const snapshot = makeSnapshot({
        promotions: [
          {
            id: "promo-1",
            name: "Sale 10%",
            description: null,
            scope: "store",
            product_id: null,
            type: "percentage",
            discount_percent: 10,
            start_date: null,
            end_date: null,
            weekdays: null,
            enabled: true,
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      });

      ingestBootstrapSnapshot(db, snapshot);

      const promotions = db.prepare("SELECT * FROM promotions").all();
      expect(promotions).toHaveLength(1);
      db.close();
    });

    it("persists provider purchases into the local store", () => {
      const db = createTestDb();
      const snapshot = makeSnapshot({
        provider_purchases: [
          {
            id: "pp-1",
            provider_name: "Provider Co",
            amount: "500.00",
            payment_method: "transfer",
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      });

      ingestBootstrapSnapshot(db, snapshot);

      const purchases = db.prepare("SELECT * FROM provider_purchases").all();
      expect(purchases).toHaveLength(1);
      db.close();
    });

    it("marks bootstrap as complete and records sync cursor after ingestion", () => {
      const db = createTestDb();
      ingestBootstrapSnapshot(db, makeSnapshot());

      const row = db.prepare("SELECT value FROM metadata WHERE key = 'bootstrap_status'").get() as { value: string };
      expect(row.value).toBe("complete");

      const cursorRow = db.prepare("SELECT value FROM metadata WHERE key = 'sync_cursor'").get() as { value: string };
      expect(cursorRow.value).toBe("2024-01-15T12:00:00.000Z");
      db.close();
    });

    it("runs ingestion in a transaction so partial failure rolls back", () => {
      const db = createTestDb();
      // Missing required field should cause an error
      const badSnapshot = {
        ...makeSnapshot(),
        products: [{ id: "bad" } as unknown as BootstrapSnapshot["products"][0]],
      };

      expect(() => ingestBootstrapSnapshot(db, badSnapshot)).toThrow();

      // Products table should be empty because the transaction rolled back
      const products = db.prepare("SELECT * FROM products").all();
      expect(products).toHaveLength(0);

      // Bootstrap status should NOT be complete
      const row = db.prepare("SELECT value FROM metadata WHERE key = 'bootstrap_status'").get() as { value: string };
      expect(row.value).not.toBe("complete");
      db.close();
    });

    it("is idempotent — running ingestion twice does not duplicate data", () => {
      const db = createTestDb();
      const snapshot = makeSnapshot({
        products: [
          {
            id: "p-1",
            detalle: "Test",
            costo_neto: null,
            costo_final: null,
            iva: null,
            cambio_costo: "fixed",
            cambio_precio: "fixed",
            etiqueta: "T",
            facturable: true,
            maneja_stock: false,
            codigos: [],
            pricing_mode: "fixed",
            is_protected: false,
            created_at: "2024-01-01T00:00:00.000Z",
            updated_at: "2024-01-01T00:00:00.000Z",
          },
        ],
      });

      ingestBootstrapSnapshot(db, snapshot);
      ingestBootstrapSnapshot(db, snapshot);

      const products = db.prepare("SELECT * FROM products").all();
      expect(products).toHaveLength(1);
      db.close();
    });
  });

  describe("startBootstrap / resumeBootstrap", () => {
    it("startBootstrap calls the backend and ingests the snapshot", async () => {
      const db = createTestDb();
      const snapshot = makeSnapshot();

      // Mock fetch for the backend call
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      const result = await startBootstrap(db, "test-token", MOCK_BACKEND_URL);

      expect(result.status).toBe("complete");
      expect(result.ready).toBe(true);

      // Verify data was ingested
      const state = getOfflineState(db);
      expect(state.bootstrap).toBe("complete");
      expect(state.ready).toBe(true);

      globalThis.fetch = originalFetch;
      db.close();
    });

    it("startBootstrap marks bootstrap as failed when backend call fails", async () => {
      const db = createTestDb();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ message: "Unauthorized" }),
      });

      const result = await startBootstrap(db, "bad-token", MOCK_BACKEND_URL);

      expect(result.status).toBe("failed");
      expect(result.ready).toBe(false);
      expect(result.error).toBeDefined();

      const state = getOfflineState(db);
      expect(state.bootstrap).toBe("failed");

      globalThis.fetch = originalFetch;
      db.close();
    });

    it("resumeBootstrap restarts bootstrap when status is pending or in_progress", async () => {
      const db = createTestDb();
      const snapshot = makeSnapshot();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(snapshot),
      });

      // Set in_progress first to simulate interrupted state
      db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'in_progress')").run();

      const result = await resumeBootstrap(db, "token", MOCK_BACKEND_URL);

      expect(result.status).toBe("complete");
      globalThis.fetch = originalFetch;
      db.close();
    });

    it("resumeBootstrap does nothing when bootstrap is already complete", async () => {
      const db = createTestDb();
      ingestBootstrapSnapshot(db, makeSnapshot());

      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      const result = await resumeBootstrap(db, "token", MOCK_BACKEND_URL);

      expect(result.status).toBe("complete");
      expect(fetchSpy).not.toHaveBeenCalled();

      globalThis.fetch = originalFetch;
      db.close();
    });

    it("getBootstrapStatus returns ready=false after getOfflineState when not bootstrapped", () => {
      const db = createTestDb();
      const state = getOfflineState(db);
      expect(state.ready).toBe(false);
      expect(state.bootstrap).toBe("pending");
      db.close();
    });
  });
});
