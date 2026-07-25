import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import Database from "better-sqlite3"

import { closeDatabase, getDatabasePath, openDatabase, runMigrations } from "../../db"
import { OutboxSqliteRepository } from "./outbox-sqlite-repository"
import { StockSqliteRepository } from "./stock-sqlite-repository"

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "market-stock-repo-test-"))
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

function createTestDb(dir: string): Database.Database {
  const dbPath = getDatabasePath(dir)
  const db = openDatabase(dbPath)
  runMigrations(db)

  db.prepare(`
    INSERT INTO offline_sessions (user_id, username, last_validated_at, created_at, updated_at)
    VALUES ('user-1', 'cashier1', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z')
  `).run()

  db.prepare(`
    INSERT INTO metadata (key, value)
    VALUES ('installation_id', 'install-1')
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run()

  db.prepare(`
    INSERT INTO products
      (id, detalle, costo_neto, costo_final, iva, cambio_costo, cambio_precio,
       etiqueta, facturable, maneja_stock, codigos, pricing_mode, is_protected,
       created_at, updated_at)
    VALUES
      ('prod-1', 'Leche Entera 1L', NULL, '120.00', NULL, 'fixed', 'fixed', '', 1, 1, '["LEC-0001"]', 'fixed', 0, '2026-01-01', '2026-01-01')
  `).run()

  db.prepare(`
    INSERT INTO stock_balances (product_id, stock_actual, updated_at)
    VALUES ('prod-1', 10, '2026-01-01')
  `).run()

  return db
}

describe("StockSqliteRepository", () => {
  let dir: string
  let db: Database.Database
  let repo: StockSqliteRepository

  beforeEach(() => {
    dir = tempDir()
    db = createTestDb(dir)
    repo = new StockSqliteRepository(() => db, new OutboxSqliteRepository(() => db))
  })

  afterEach(() => {
    closeDatabase(db)
    cleanup(dir)
  })

  it("adjusts local stock and enqueues a stock_adjust outbox entry atomically", () => {
    const movement = repo.adjust({
      product_id: "prod-1",
      quantity: 5,
      reason: "manual recount",
    })

    expect(movement.success).toBe(true)
    expect(movement.movement?.previousStock).toBe(10)
    expect(movement.movement?.newStock).toBe(15)

    const balance = db.prepare("SELECT stock_actual FROM stock_balances WHERE product_id = ?").get("prod-1") as { stock_actual: number }
    expect(balance.stock_actual).toBe(15)

    const outbox = db.prepare("SELECT operation_type, aggregate_type, aggregate_id, payload, status FROM outbox WHERE operation_type = 'stock_adjust' LIMIT 1").get() as {
      operation_type: string
      aggregate_type: string
      aggregate_id: string
      payload: string
      status: string
    }

    expect(outbox.operation_type).toBe("stock_adjust")
    expect(outbox.aggregate_type).toBe("stock")
    expect(outbox.aggregate_id).toBe("prod-1")
    expect(outbox.status).toBe("pending")

    const payload = JSON.parse(outbox.payload) as {
      product_id: string
      quantity: number
      reason: string
      local_balance_after: number
    }

    expect(payload.product_id).toBe("prod-1")
    expect(payload.quantity).toBe(5)
    expect(payload.reason).toBe("manual recount")
    expect(payload.local_balance_after).toBe(15)
  })
})
