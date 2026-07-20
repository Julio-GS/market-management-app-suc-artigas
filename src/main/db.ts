import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

const DB_FILENAME = "market-management.sqlite";
const OFFLINE_DIR = "offline";

/** Busy timeout in ms for SQLite write contention. */
const BUSY_TIMEOUT_MS = 5000;

/**
 * Compute the full database path under `userData/offline/market-management.sqlite`.
 * Creates the offline directory if it does not exist.
 */
export function getDatabasePath(userDataPath: string): string {
  const offlineDir = path.join(userDataPath, OFFLINE_DIR);
  fs.mkdirSync(offlineDir, { recursive: true });
  return path.join(offlineDir, DB_FILENAME);
}

/**
 * Open (or create) the SQLite database at `dbPath`.
 *
 * - Enables WAL journal mode for durability and concurrency.
 * - Sets a busy timeout so writers block briefly instead of failing immediately.
 * - Enables foreign keys.
 */
export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);

  db.pragma("journal_mode = WAL");
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma("foreign_keys = ON");

  return db;
}

/**
 * Close a database connection cleanly.
 */
export function closeDatabase(db: Database.Database): void {
  db.close();
}

// ---------------------------------------------------------------------------
// Migration foundation
// ---------------------------------------------------------------------------

/** Ordered list of migrations. Each entry maps a numeric version to raw SQL. */
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version   INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      INSERT OR IGNORE INTO metadata (key, value) VALUES ('bootstrap_status', 'pending');
      INSERT OR IGNORE INTO metadata (key, value) VALUES ('last_sync_at', '');
      INSERT OR IGNORE INTO metadata (key, value) VALUES ('degraded', '0');
      INSERT OR IGNORE INTO metadata (key, value) VALUES ('schema_version', '1');
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS products (
        id            TEXT PRIMARY KEY,
        detalle       TEXT NOT NULL,
        costo_neto    TEXT,
        costo_final   TEXT,
        iva           TEXT,
        cambio_costo  TEXT NOT NULL DEFAULT 'fixed',
        cambio_precio TEXT NOT NULL DEFAULT 'fixed',
        etiqueta      TEXT NOT NULL DEFAULT '',
        facturable    INTEGER NOT NULL DEFAULT 1,
        maneja_stock  INTEGER NOT NULL DEFAULT 1,
        codigos       TEXT NOT NULL DEFAULT '[]',
        pricing_mode  TEXT NOT NULL DEFAULT 'fixed',
        is_protected  INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stock_balances (
        product_id   TEXT PRIMARY KEY,
        stock_actual INTEGER NOT NULL DEFAULT 0,
        updated_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS promotions (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        description      TEXT,
        scope            TEXT NOT NULL DEFAULT 'product',
        product_id       TEXT,
        type             TEXT NOT NULL,
        discount_percent REAL,
        start_date       TEXT,
        end_date         TEXT,
        weekdays         TEXT,
        enabled          INTEGER NOT NULL DEFAULT 1,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_purchases (
        id             TEXT PRIMARY KEY,
        provider_name  TEXT NOT NULL,
        amount         TEXT NOT NULL,
        payment_method TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS offline_sessions (
        user_id                TEXT PRIMARY KEY,
        username               TEXT NOT NULL,
        last_validated_at      TEXT NOT NULL,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );

      INSERT OR IGNORE INTO metadata (key, value) VALUES ('sync_cursor', '');
      INSERT OR IGNORE INTO metadata (key, value) VALUES ('installation_id', '');
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS sales (
        id               TEXT PRIMARY KEY,
        total            TEXT NOT NULL,
        customer         TEXT NOT NULL DEFAULT 'Mostrador',
        invoice_status   TEXT NOT NULL DEFAULT 'none',
        invoice_requested INTEGER NOT NULL DEFAULT 0,
        cae              TEXT,
        cae_vto          TEXT,
        cbte_nro         TEXT,
        cbte_tipo        TEXT,
        pto_vta          TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sale_items (
        id               TEXT PRIMARY KEY,
        sale_id          TEXT NOT NULL REFERENCES sales(id),
        product_id       TEXT NOT NULL,
        name             TEXT NOT NULL,
        description      TEXT,
        quantity         INTEGER NOT NULL,
        unit_price       TEXT NOT NULL,
        subtotal         TEXT NOT NULL,
        discount_amount  TEXT NOT NULL DEFAULT '0.00',
        applied_promotion_id   TEXT,
        applied_promotion_type TEXT,
        created_at       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sale_payments (
        id               TEXT PRIMARY KEY,
        sale_id          TEXT NOT NULL REFERENCES sales(id),
        method           TEXT NOT NULL,
        amount           TEXT NOT NULL,
        created_at       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS stock_movements (
        id               TEXT PRIMARY KEY,
        product_id       TEXT NOT NULL,
        quantity         INTEGER NOT NULL,
        reason           TEXT NOT NULL,
        sale_id          TEXT,
        created_at       TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outbox (
        id               TEXT PRIMARY KEY,
        idempotency_key  TEXT NOT NULL UNIQUE,
        operation_type   TEXT NOT NULL,
        aggregate_type   TEXT NOT NULL,
        aggregate_id     TEXT NOT NULL,
        payload          TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending',
        base_server_version TEXT,
        actor_user_id    TEXT,
        attempt_count    INTEGER NOT NULL DEFAULT 0,
        next_retry_at    TEXT,
        last_error       TEXT,
        server_result    TEXT,
        created_at       TEXT NOT NULL,
        updated_at       TEXT NOT NULL,
        synced_at        TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status);
      CREATE INDEX IF NOT EXISTS idx_outbox_aggregate ON outbox(aggregate_type, aggregate_id);
      CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
      CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
      CREATE INDEX IF NOT EXISTS idx_sale_payments_sale ON sale_payments(sale_id);
    `,
  },
];

/**
 * Run pending migrations against `db`. Idempotent — migrations already
 * recorded in `schema_migrations` are skipped.
 *
 * Returns the number of newly applied migrations.
 */
export function runMigrations(db: Database.Database): number {
  // Ensure the bookkeeping table exists before we query it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );

  let appliedCount = 0;

  const insertVersion = db.prepare(
    "INSERT INTO schema_migrations (version) VALUES (?)",
  );

  const runInTransaction = db.transaction(() => {
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) {
        continue;
      }
      db.exec(migration.sql);
      insertVersion.run(migration.version);
      appliedCount += 1;
    }
  });

  runInTransaction();

  return appliedCount;
}
