import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// We test pull-reconciliation by mocking better-sqlite3 fully and importing
// the module under test. The tests focus on cursor safety semantics.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers — build mock DB objects that behave like better-sqlite3 for our uses
// ---------------------------------------------------------------------------

interface MockDbOptions {
  syncCursor?: string | null;
  lastSyncAt?: string | null;
  /** product IDs that exist — used by applyProduct/applyPromotion etc. */
  existingProductIds?: string[];
  existingPromotionIds?: string[];
  existingProviderPurchaseIds?: string[];
  existingStockBalances?: Array<{ product_id: string; stock_actual: number }>;
}

type MockPrepFn = (sql: string) => {
  get: () => unknown;
  run: (params?: Record<string, unknown>) => { changes: number };
  all: () => unknown[];
};

function makeMockDb(opts: MockDbOptions = {}) {
  const metadata = new Map<string, string>();
  if (opts.syncCursor) metadata.set("sync_cursor", opts.syncCursor);
  if (opts.lastSyncAt) metadata.set("last_sync_at", opts.lastSyncAt);

  const existingProductIds = new Set(opts.existingProductIds ?? []);
  const existingStockBalances = new Map(
    (opts.existingStockBalances ?? []).map((b) => [b.product_id, b]),
  );

  const prepare: MockPrepFn = (sql: string) => {
    // -- metadata writes (must come before reads because INSERT includes key names) --
    if (sql.includes("INSERT OR REPLACE INTO metadata")) {
      // Detect which key is being written from the SQL literal
      const keyMatch = sql.match(/VALUES \('(\w+)'/);
      const metaKey = keyMatch ? keyMatch[1] : null;
      return {
        get: () => undefined,
        run: (value?: unknown) => {
          if (metaKey) metadata.set(metaKey, String(value ?? ""));
          return { changes: 1 };
        },
        all: () => [],
      };
    }

    // -- metadata reads --
    if (sql.includes("metadata") && sql.includes("sync_cursor")) {
      return {
        get: () => {
          const v = metadata.get("sync_cursor");
          return v ? { value: v } : undefined;
        },
        run: (params?: Record<string, unknown>) => {
          const p = params as Record<string, string> | undefined;
          if (p?.key) metadata.set(p.key, p.value ?? "");
          return { changes: 1 };
        },
        all: () => [],
      };
    }
    if (sql.includes("metadata") && sql.includes("last_sync_at")) {
      return {
        get: () => {
          const v = metadata.get("last_sync_at");
          return v ? { value: v } : undefined;
        },
        run: (params?: Record<string, unknown>) => {
          const p = params as Record<string, string> | undefined;
          if (p?.key) metadata.set(p.key, p.value ?? "");
          return { changes: 1 };
        },
        all: () => [],
      };
    }
    // -- product existence check (SELECT id FROM products WHERE id = ?) --
    if (sql.includes("products") && sql.includes("SELECT id FROM")) {
      return {
        get: () => {
          // Extract the ID from the bound parameters (not easy from SQL string
          // alone, but the mock's get() returns the first matching product in
          // the set for the query — close enough for our cursor tests)
          // We cheat: if any product exists, return { id: "any" } so the code
          // takes the UPDATE path. For delete-on-non-existent tests we return
          // undefined when the set is empty.
          if (existingProductIds.size === 0) return undefined;
          return { id: [...existingProductIds][0] };
        },
        run: () => ({ changes: 1 }),
        all: () => [],
      };
    }

    // -- stock_balances existence check --
    if (sql.includes("stock_balances") && sql.includes("SELECT product_id")) {
      return {
        get: () => {
          // Return first existing balance or undefined
          const first = existingStockBalances.values().next().value;
          return first ?? undefined;
        },
        run: () => ({ changes: 1 }),
        all: () => [],
      };
    }

    // -- promotions / provider_purchases existence checks --
    if (sql.includes("promotions") && sql.includes("SELECT id FROM")) {
      return {
        get: () =>
          (opts.existingPromotionIds?.length ?? 0) > 0
            ? { id: (opts.existingPromotionIds ?? [])[0] }
            : undefined,
        run: () => ({ changes: 1 }),
        all: () => [],
      };
    }
    if (sql.includes("provider_purchases") && sql.includes("SELECT id FROM")) {
      return {
        get: () =>
          (opts.existingProviderPurchaseIds?.length ?? 0) > 0
            ? { id: (opts.existingProviderPurchaseIds ?? [])[0] }
            : undefined,
        run: () => ({ changes: 1 }),
        all: () => [],
      };
    }

    // -- generic write (UPDATE/INSERT/DELETE) --
    return {
      get: () => undefined,
      run: () => ({ changes: 1 }),
      all: () => [],
    };
  };

  const transaction = vi.fn((fn: () => void) => {
    return () => fn();
  });

  return { prepare, transaction, metadata };
}

// Must import after we have the mock shape defined, but we don't actually mock
// better-sqlite3 — we pass our mock objects directly.
import {
  pullAndApply,
  getSyncCursor,
  setLastSyncAt,
  type PullFn,
} from "./pull-reconciliation";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("pull-reconciliation", () => {
  describe("pullAndApply cursor safety", () => {
    it("does NOT advance cursor when a change has an unknown aggregate_type", async () => {
      const db = makeMockDb({ syncCursor: "cursor-v1" }) as any;

      const pullFn: PullFn = async () => ({
        changes: [
          {
            id: "unk-1",
            aggregate_type: "unknown_type" as any,
            operation_type: "unknown",
            server_version: "v1",
            server_applied_at: "2026-07-18T10:00:00.000Z",
            payload: {},
          },
        ],
        cursor: "cursor-v2",
        has_more: false,
      });

      const result = await pullAndApply(db, pullFn);

      // Cursor must NOT advance past unsupported aggregate type
      expect(result.skipped).toBeGreaterThan(0);
      expect(result.applied).toBe(0);
      expect(db.metadata.get("sync_cursor")).toBe("cursor-v1");
    });

    it("does NOT advance cursor when stock apply fails (missing product_id)", async () => {
      const db = makeMockDb({
        syncCursor: "cursor-v1",
        existingStockBalances: [], // no existing balances
      }) as any;

      const pullFn: PullFn = async () => ({
        changes: [
          {
            id: "stock-fail",
            aggregate_type: "stock" as const,
            operation_type: "stock_update",
            server_version: "v2",
            server_applied_at: "2026-07-18T10:00:00.000Z",
            payload: {
              // Missing product_id — applyStockBalance returns false
              stock_actual: 10,
            },
          },
        ],
        cursor: "cursor-v2",
        has_more: false,
      });

      const result = await pullAndApply(db, pullFn);

      expect(result.skipped).toBeGreaterThan(0);
      expect(db.metadata.get("sync_cursor")).toBe("cursor-v1");
    });

    it("advances cursor when all changes are successfully applied", async () => {
      const db = makeMockDb({
        syncCursor: "cursor-v1",
        existingProductIds: [], // no existing product → INSERT path
      }) as any;

      const pullFn: PullFn = async () => ({
        changes: [
          {
            id: "prod-new",
            aggregate_type: "product" as const,
            operation_type: "product_create",
            server_version: "v2",
            server_applied_at: "2026-07-18T10:00:00.000Z",
            payload: {
              detalle: "New Product",
              costo_final: "20.00",
            },
          },
        ],
        cursor: "cursor-v2",
        has_more: false,
      });

      const result = await pullAndApply(db, pullFn);

      expect(result.skipped).toBe(0);
      expect(result.applied).toBe(1);
      expect(db.metadata.get("sync_cursor")).toBe("cursor-v2");
    });

    it("treats delete-on-non-existent as idempotent (cursor advances)", async () => {
      const db = makeMockDb({
        syncCursor: "cursor-v1",
        existingProductIds: [], // product does NOT exist
      }) as any;

      const pullFn: PullFn = async () => ({
        changes: [
          {
            id: "prod-deleted",
            aggregate_type: "product" as const,
            operation_type: "product_delete",
            server_version: "v2",
            server_applied_at: "2026-07-18T10:00:00.000Z",
            deleted: true,
            payload: {},
          },
        ],
        cursor: "cursor-v2",
        has_more: false,
      });

      const result = await pullAndApply(db, pullFn);

      // Already-deleted is idempotent → cursor advances
      expect(result.skipped).toBe(0);
      expect(result.applied).toBe(1);
      expect(db.metadata.get("sync_cursor")).toBe("cursor-v2");
    });

    it("returns safe defaults when pullFn throws a network error", async () => {
      const db = makeMockDb({ syncCursor: "cursor-v1" }) as any;

      const pullFn: PullFn = async () => {
        throw new Error("Network error");
      };

      const result = await pullAndApply(db, pullFn);

      expect(result.applied).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.cursor).toBeNull();
      expect(result.hasMore).toBe(false);
    });
  });

  describe("getSyncCursor", () => {
    it("returns null when no cursor exists in metadata", () => {
      const db = makeMockDb({}) as any;
      expect(getSyncCursor(db)).toBeNull();
    });

    it("returns the cursor value from metadata", () => {
      const db = makeMockDb({ syncCursor: "cursor-abc" }) as any;
      expect(getSyncCursor(db)).toBe("cursor-abc");
    });
  });

  describe("setLastSyncAt", () => {
    it("writes ISO timestamp to metadata", () => {
      const db = makeMockDb({}) as any;
      setLastSyncAt(db);
      expect(db.metadata.get("last_sync_at")).toBeTruthy();
    });
  });
});
