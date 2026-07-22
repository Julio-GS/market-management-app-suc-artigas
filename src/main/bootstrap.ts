import type Database from "better-sqlite3";
import type { BootstrapStatus } from "./offline-state";

// ---------------------------------------------------------------------------
// Bootstrap snapshot contract — mirrors backend POST /sync/bootstrap response
// ---------------------------------------------------------------------------

export interface BootstrapProduct {
  id: string;
  detalle: string;
  costo_neto: string | null;
  costo_final: string | null;
  iva: string | null;
  cambio_costo: string;
  cambio_precio: string;
  etiqueta: string;
  facturable: boolean;
  maneja_stock: boolean;
  codigos: string[];
  pricing_mode: string;
  is_protected: boolean;
  created_at: string;
  updated_at: string;
}

export interface BootstrapStockBalance {
  product_id: string;
  stock_actual: number;
  updated_at: string;
}

export interface BootstrapPromotion {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  product_id: string | null;
  type: string;
  discount_percent: number | null;
  start_date: string | null;
  end_date: string | null;
  weekdays: number[] | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface BootstrapProviderPurchase {
  id: string;
  provider_name: string;
  amount: string;
  payment_method: string | null;
  created_at: string;
  updated_at: string;
}

export interface BootstrapUserProfile {
  id: string;
  username: string;
  created_at: string;
  updated_at: string;
}

export interface BootstrapSnapshot {
  products: BootstrapProduct[];
  stock_balances: BootstrapStockBalance[];
  promotions: BootstrapPromotion[];
  provider_purchases: BootstrapProviderPurchase[];
  user_profile: BootstrapUserProfile;
  sync_cursor: string;
}

// ---------------------------------------------------------------------------
// Bootstrap status result
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  status: BootstrapStatus;
  ready: boolean;
  syncCursor: string | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// Status query
// ---------------------------------------------------------------------------

/**
 * Read the current bootstrap status from metadata.
 * Does NOT rely on getOfflineState — this is a focused read for the bootstrap
 * IPC handler so it can be called before the full state is meaningful.
 */
export function getBootstrapStatus(db: Database.Database): BootstrapResult {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metadata'")
    .get();

  if (!tableExists) {
    return { status: "pending", ready: false, syncCursor: null };
  }

  const rows = db
    .prepare("SELECT key, value FROM metadata WHERE key IN ('bootstrap_status','sync_cursor')")
    .all() as { key: string; value: string }[];

  const map = new Map(rows.map((r) => [r.key, r.value]));
  const status = (map.get("bootstrap_status") ?? "pending") as BootstrapStatus;
  const syncCursor = map.get("sync_cursor") || null;

  return {
    status,
    ready: status === "complete",
    syncCursor,
  };
}

// ---------------------------------------------------------------------------
// Snapshot ingestion
// ---------------------------------------------------------------------------

/**
 * Ingest a bootstrap snapshot into the local SQLite store.
 *
 * - Runs in a single transaction so partial failure rolls back.
 * - Idempotent: uses INSERT OR REPLACE so re-running does not duplicate data.
 * - Sets bootstrap_status to 'complete' and records the sync cursor.
 */
export function ingestBootstrapSnapshot(
  db: Database.Database,
  snapshot: BootstrapSnapshot,
): void {
  const run = db.transaction(() => {
    // Products
    const insertProduct = db.prepare(`
      INSERT OR REPLACE INTO products
        (id, detalle, costo_neto, costo_final, iva, cambio_costo, cambio_precio,
         etiqueta, facturable, maneja_stock, codigos, pricing_mode, is_protected,
         created_at, updated_at)
      VALUES
        (@id, @detalle, @costo_neto, @costo_final, @iva, @cambio_costo, @cambio_precio,
         @etiqueta, @facturable, @maneja_stock, @codigos, @pricing_mode, @is_protected,
         @created_at, @updated_at)
    `);

    for (const p of snapshot.products) {
      insertProduct.run({
        id: p.id,
        detalle: p.detalle,
        costo_neto: p.costo_neto,
        costo_final: p.costo_final,
        iva: p.iva,
        cambio_costo: p.cambio_costo,
        cambio_precio: p.cambio_precio,
        etiqueta: p.etiqueta,
        facturable: p.facturable ? 1 : 0,
        maneja_stock: p.maneja_stock ? 1 : 0,
        codigos: JSON.stringify(p.codigos),
        pricing_mode: p.pricing_mode,
        is_protected: p.is_protected ? 1 : 0,
        created_at: p.created_at,
        updated_at: p.updated_at,
      });
    }

    // Stock balances
    const insertStock = db.prepare(`
      INSERT OR REPLACE INTO stock_balances
        (product_id, stock_actual, updated_at)
      VALUES
        (@product_id, @stock_actual, @updated_at)
    `);

    for (const s of snapshot.stock_balances) {
      insertStock.run({
        product_id: s.product_id,
        stock_actual: s.stock_actual,
        updated_at: s.updated_at,
      });
    }

    // Promotions
    const insertPromotion = db.prepare(`
      INSERT OR REPLACE INTO promotions
        (id, name, description, scope, product_id, type, discount_percent,
         start_date, end_date, weekdays, enabled, created_at, updated_at)
      VALUES
        (@id, @name, @description, @scope, @product_id, @type, @discount_percent,
         @start_date, @end_date, @weekdays, @enabled, @created_at, @updated_at)
    `);

    for (const p of snapshot.promotions) {
      insertPromotion.run({
        id: p.id,
        name: p.name,
        description: p.description,
        scope: p.scope,
        product_id: p.product_id,
        type: p.type,
        discount_percent: p.discount_percent,
        start_date: p.start_date,
        end_date: p.end_date,
        weekdays: p.weekdays ? JSON.stringify(p.weekdays) : null,
        enabled: p.enabled ? 1 : 0,
        created_at: p.created_at,
        updated_at: p.updated_at,
      });
    }

    // Provider purchases
    const insertProviderPurchase = db.prepare(`
      INSERT OR REPLACE INTO provider_purchases
        (id, provider_name, amount, payment_method, created_at, updated_at)
      VALUES
        (@id, @provider_name, @amount, @payment_method, @created_at, @updated_at)
    `);

    for (const pp of snapshot.provider_purchases) {
      insertProviderPurchase.run({
        id: pp.id,
        provider_name: pp.provider_name,
        amount: pp.amount,
        payment_method: pp.payment_method,
        created_at: pp.created_at,
        updated_at: pp.updated_at,
      });
    }

    // Offline session — record the user who bootstrapped
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO offline_sessions
        (user_id, username, last_validated_at, created_at, updated_at, password_hash)
      VALUES
        (@user_id, @username, @last_validated_at, @created_at, @updated_at, NULL)
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username,
        last_validated_at = excluded.last_validated_at,
        updated_at = excluded.updated_at,
        password_hash = offline_sessions.password_hash
    `).run({
      user_id: snapshot.user_profile.id,
      username: snapshot.user_profile.username,
      last_validated_at: now,
      created_at: snapshot.user_profile.created_at,
      updated_at: now,
    });

    // Mark bootstrap as complete
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'complete')",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('sync_cursor', ?)",
    ).run(snapshot.sync_cursor);
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync_at', ?)",
    ).run(now);
  });

  run();
}

// ---------------------------------------------------------------------------
// Bootstrap orchestration
// ---------------------------------------------------------------------------

/**
 * Start bootstrap: call the backend, ingest the snapshot.
 *
 * @param db          The database instance.
 * @param token       JWT access token for the backend call.
 * @param apiBaseUrl  Backend base URL (e.g. http://localhost:3001/api/v1).
 */
export async function startBootstrap(
  db: Database.Database,
  token: string,
  apiBaseUrl: string,
): Promise<BootstrapResult> {
  // Mark in_progress before the network call
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'in_progress')",
  ).run();

  try {
    const response = await fetch(`${apiBaseUrl}/sync/bootstrap`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      const message = tryParseErrorMessage(body, response.status);
      db.prepare(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'failed')",
      ).run();
      return { status: "failed", ready: false, syncCursor: null, error: message };
    }

    const snapshot = (await response.json()) as BootstrapSnapshot;
    ingestBootstrapSnapshot(db, snapshot);

    return getBootstrapStatus(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown bootstrap error";
    db.prepare(
      "INSERT OR REPLACE INTO metadata (key, value) VALUES ('bootstrap_status', 'failed')",
    ).run();
    return { status: "failed", ready: false, syncCursor: null, error: message };
  }
}

/**
 * Resume or restart bootstrap.
 *
 * - If bootstrap is already complete, returns the current status without
 *   re-fetching.
 * - If bootstrap is pending or in_progress, restarts from scratch via
 *   startBootstrap.
 * - If bootstrap is failed, also restarts (the caller may also call
 *   startBootstrap directly).
 */
export async function resumeBootstrap(
  db: Database.Database,
  token: string,
  apiBaseUrl: string,
): Promise<BootstrapResult> {
  const current = getBootstrapStatus(db);

  if (current.status === "complete") {
    return current;
  }

  // pending, in_progress, or failed — restart
  return startBootstrap(db, token, apiBaseUrl);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tryParseErrorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { message?: string };
    return parsed.message ?? `Backend returned status ${status}`;
  } catch {
    return `Backend returned status ${status}`;
  }
}
