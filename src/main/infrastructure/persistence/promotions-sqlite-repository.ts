// ---------------------------------------------------------------------------
// Infrastructure: Promotions SQLite repository
//
// Implements IPromotionsRepository using better-sqlite3. Preserves all existing
// SQL, row mapping, transaction boundaries, outbox semantics, auth guards, and
// revalidation behavior from the original promotions-local.ts.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  assertOfflineEligible,
  getActorUserId,
  markOfflineWorkRequiresRevalidation,
} from "../../offline-auth";
import type { IPromotionsRepository } from "../../domain/promotions/promotions-repository";
import type {
  OfflinePromotionInput,
  OfflinePromotionResult,
  OfflinePromotionUpdateInput,
} from "../../domain/promotions/promotion";
import type { IOutboxRepository } from "../../ports/outbox-repository";

// Re-export for IPC error mapping
export { OfflineAuthRequiredError } from "../../offline-auth";

// ---------------------------------------------------------------------------
// Internal row shape (database representation — NOT exported)
// ---------------------------------------------------------------------------

interface OfflinePromotionRow {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  product_id: string | null;
  type: string;
  discount_percent: number | null;
  start_date: string | null;
  end_date: string | null;
  weekdays: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getInstallationId(db: Database.Database): string {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = 'installation_id'")
    .get() as { value: string } | undefined;
  return row?.value || "unknown-install";
}

function now(): string {
  return new Date().toISOString();
}

function mapRow(row: OfflinePromotionRow): OfflinePromotionResult["promotion"] {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    scope: row.scope,
    productId: row.product_id,
    type: row.type,
    discountPercent: row.discount_percent,
    startDate: row.start_date,
    endDate: row.end_date,
    weekdays: row.weekdays ? JSON.parse(row.weekdays) : null,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class PromotionsSqliteRepository implements IPromotionsRepository {
  constructor(
    private readonly getDb: () => Database.Database,
    private readonly outboxRepository: IOutboxRepository,
  ) {}

  create(input: OfflinePromotionInput): OfflinePromotionResult {
    const db = this.getDb();
    assertOfflineEligible(db);

    const promoId = randomUUID();
    const createdAt = now();
    const installationId = getInstallationId(db);
    const actorUserId = getActorUserId(db);

    const run = db.transaction(() => {
      db.prepare(`
        INSERT INTO promotions
          (id, name, description, scope, product_id, type, discount_percent,
           start_date, end_date, weekdays, enabled, created_at, updated_at)
        VALUES
          (@id, @name, @description, @scope, @product_id, @type, @discount_percent,
           @start_date, @end_date, @weekdays, 1, @created_at, @created_at)
      `).run({
        id: promoId,
        name: input.name,
        description: input.description ?? null,
        scope: input.scope ?? "product",
        product_id: input.product_id ?? null,
        type: input.type,
        discount_percent: input.discount_percent ?? null,
        start_date: input.start_date ?? null,
        end_date: input.end_date ?? null,
        weekdays: input.weekdays ? JSON.stringify(input.weekdays) : null,
        created_at: createdAt,
      });

      this.outboxRepository.enqueue({
        operationType: "promotion_create",
        aggregateType: "promotion",
        aggregateId: promoId,
        payload: {
          id: promoId,
          name: input.name,
          description: input.description ?? null,
          scope: input.scope ?? "product",
          product_id: input.product_id ?? null,
          type: input.type,
          discount_percent: input.discount_percent ?? null,
          start_date: input.start_date ?? null,
          end_date: input.end_date ?? null,
          weekdays: input.weekdays ?? null,
        },
        createdAt,
        installationId,
        actorUserId,
        entityLabel: `Promotion create: ${input.name}`,
      });

      markOfflineWorkRequiresRevalidation(db);
    });

    run();

    const row = db.prepare("SELECT * FROM promotions WHERE id = ?").get(promoId) as OfflinePromotionRow | undefined;
    if (!row) {
      return { success: false, error: "Promotion not found after creation" };
    }

    return { success: true, promotion: mapRow(row) };
  }

  update(promotionId: string, input: OfflinePromotionUpdateInput): OfflinePromotionResult {
    const db = this.getDb();
    assertOfflineEligible(db);

    const createdAt = now();
    const installationId = getInstallationId(db);
    const actorUserId = getActorUserId(db);

    const existing = db.prepare("SELECT * FROM promotions WHERE id = ?").get(promotionId) as OfflinePromotionRow | undefined;
    if (!existing) {
      return { success: false, error: "Promotion not found" };
    }

    const run = db.transaction(() => {
      const stmt = db.prepare(`
        UPDATE promotions SET
          name = COALESCE(@name, name),
          description = COALESCE(@description, description),
          scope = COALESCE(@scope, scope),
          product_id = COALESCE(@product_id, product_id),
          type = COALESCE(@type, type),
          discount_percent = COALESCE(@discount_percent, discount_percent),
          start_date = COALESCE(@start_date, start_date),
          end_date = COALESCE(@end_date, end_date),
          weekdays = COALESCE(@weekdays, weekdays),
          enabled = COALESCE(@enabled, enabled),
          updated_at = @updated_at
        WHERE id = @id
      `);

      stmt.run({
        id: promotionId,
        name: input.name ?? null,
        description: input.description !== undefined ? input.description : null,
        scope: input.scope ?? null,
        product_id: input.product_id !== undefined ? input.product_id : null,
        type: input.type ?? null,
        discount_percent: input.discount_percent !== undefined ? input.discount_percent : null,
        start_date: input.start_date !== undefined ? input.start_date : null,
        end_date: input.end_date !== undefined ? input.end_date : null,
        weekdays: input.weekdays !== undefined ? (input.weekdays ? JSON.stringify(input.weekdays) : null) : null,
        enabled: input.enabled !== undefined ? (input.enabled ? 1 : 0) : null,
        updated_at: createdAt,
      });

      const payload: Record<string, unknown> = { id: promotionId };
      if (input.name !== undefined) payload.name = input.name;
      if (input.description !== undefined) payload.description = input.description;
      if (input.scope !== undefined) payload.scope = input.scope;
      if (input.product_id !== undefined) payload.product_id = input.product_id;
      if (input.type !== undefined) payload.type = input.type;
      if (input.discount_percent !== undefined) payload.discount_percent = input.discount_percent;
      if (input.start_date !== undefined) payload.start_date = input.start_date;
      if (input.end_date !== undefined) payload.end_date = input.end_date;
      if (input.weekdays !== undefined) payload.weekdays = input.weekdays;
      if (input.enabled !== undefined) payload.enabled = input.enabled;

      this.outboxRepository.enqueue({
        operationType: "promotion_update",
        aggregateType: "promotion",
        aggregateId: promotionId,
        payload,
        createdAt,
        installationId,
        actorUserId,
        entityLabel: `Promotion update: ${promotionId.slice(0, 8)}`,
      });

      markOfflineWorkRequiresRevalidation(db);
    });

    run();

    const row = db.prepare("SELECT * FROM promotions WHERE id = ?").get(promotionId) as OfflinePromotionRow | undefined;
    if (!row) {
      return { success: false, error: "Promotion not found after update" };
    }

    return { success: true, promotion: mapRow(row) };
  }

  delete(promotionId: string): OfflinePromotionResult {
    const db = this.getDb();
    assertOfflineEligible(db);

    const createdAt = now();
    const installationId = getInstallationId(db);
    const actorUserId = getActorUserId(db);

    const existing = db.prepare("SELECT * FROM promotions WHERE id = ?").get(promotionId) as OfflinePromotionRow | undefined;
    if (!existing) {
      return { success: false, error: "Promotion not found" };
    }

    // Snapshot for recovery on rejection
    const beforeSnapshot = mapRow(existing)!;

    const run = db.transaction(() => {
      db.prepare("DELETE FROM promotions WHERE id = ?").run(promotionId);

      this.outboxRepository.enqueue({
        operationType: "promotion_delete",
        aggregateType: "promotion",
        aggregateId: promotionId,
        payload: {
          id: promotionId,
          before: beforeSnapshot,
        },
        createdAt,
        installationId,
        actorUserId,
        entityLabel: `Promotion delete: ${beforeSnapshot.name}`,
      });

      markOfflineWorkRequiresRevalidation(db);
    });

    run();

    return { success: true };
  }

  list(): OfflinePromotionResult[] {
    const db = this.getDb();
    const rows = db.prepare("SELECT * FROM promotions ORDER BY name ASC").all() as OfflinePromotionRow[];
    return rows.map((row) => ({ success: true, promotion: mapRow(row) }));
  }
}
