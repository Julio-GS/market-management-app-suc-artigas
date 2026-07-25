import { randomUUID } from "node:crypto"
import type Database from "better-sqlite3"

import {
  assertOfflineEligible,
  getActorUserId,
  markOfflineWorkRequiresRevalidation,
} from "../../offline-auth"
import type { IOutboxRepository } from "../../ports/outbox-repository"

interface StockBalanceRow {
  stock_actual: number
}

export interface OfflineStockAdjustmentInput {
  product_id: string
  quantity: number
  reason?: string
}

export interface OfflineStockMovement {
  id: string
  productId: string
  quantity: number
  type: "adjustment"
  referenceId: null
  previousStock: number
  newStock: number
  reason: string | null
  createdAt: string
}

export interface OfflineStockAdjustmentResult {
  success: boolean
  movement?: OfflineStockMovement
  error?: string
}

function now(): string {
  return new Date().toISOString()
}

function getInstallationId(db: Database.Database): string {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = 'installation_id'")
    .get() as { value: string } | undefined
  return row?.value || "unknown-install"
}

export class StockSqliteRepository {
  constructor(
    private readonly getDb: () => Database.Database,
    private readonly outboxRepository: IOutboxRepository,
  ) {}

  getStock(productId: string): number | null {
    const db = this.getDb()
    const row = db
      .prepare("SELECT stock_actual FROM stock_balances WHERE product_id = ?")
      .get(productId) as StockBalanceRow | undefined

    return row?.stock_actual ?? null
  }

  adjust(input: OfflineStockAdjustmentInput): OfflineStockAdjustmentResult {
    const db = this.getDb()
    assertOfflineEligible(db)

    const product = db
      .prepare("SELECT maneja_stock FROM products WHERE id = ?")
      .get(input.product_id) as { maneja_stock: number } | undefined

    if (!product) {
      return { success: false, error: "Product not found" }
    }

    if (product.maneja_stock === 0) {
      return { success: false, error: "Product does not manage stock" }
    }

    const createdAt = now()
    const installationId = getInstallationId(db)
    const actorUserId = getActorUserId(db)
    const movementId = randomUUID()
    const reason = input.reason?.trim() || "adjustment"

    const movement = db.transaction((): OfflineStockMovement => {
      const balanceBefore = db
        .prepare("SELECT stock_actual FROM stock_balances WHERE product_id = ?")
        .get(input.product_id) as StockBalanceRow | undefined

      const previousStock = balanceBefore?.stock_actual ?? 0
      const newStock = previousStock + input.quantity

      db.prepare(`
        INSERT INTO stock_balances (product_id, stock_actual, updated_at)
        VALUES (@product_id, @stock_actual, @updated_at)
        ON CONFLICT(product_id) DO UPDATE SET
          stock_actual = @stock_actual,
          updated_at = @updated_at
      `).run({
        product_id: input.product_id,
        stock_actual: newStock,
        updated_at: createdAt,
      })

      db.prepare(`
        INSERT INTO stock_movements
          (id, product_id, quantity, reason, sale_id, created_at)
        VALUES
          (@id, @product_id, @quantity, @reason, NULL, @created_at)
      `).run({
        id: movementId,
        product_id: input.product_id,
        quantity: input.quantity,
        reason,
        created_at: createdAt,
      })

      this.outboxRepository.enqueue({
        operationType: "stock_adjust",
        aggregateType: "stock",
        aggregateId: input.product_id,
        payload: {
          stock_movement_id: movementId,
          sale_id: null,
          product_id: input.product_id,
          quantity: input.quantity,
          reason,
          local_balance_after: newStock,
        },
        createdAt,
        installationId,
        actorUserId,
        entityLabel: `Stock adjust: ${input.product_id}`,
      })

      markOfflineWorkRequiresRevalidation(db)

      return {
        id: movementId,
        productId: input.product_id,
        quantity: input.quantity,
        type: "adjustment",
        referenceId: null,
        previousStock,
        newStock,
        reason,
        createdAt,
      }
    })()

    return { success: true, movement }
  }
}
