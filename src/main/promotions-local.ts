import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  getOfflineSession,
  assertOfflineEligible,
  getActorUserId,
  markOfflineWorkRequiresRevalidation,
  OfflineAuthRequiredError,
} from "./offline-auth";

// Re-export for IPC error mapping
export { OfflineAuthRequiredError };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OfflinePromotionInput {
  name: string;
  description?: string | null;
  scope?: string;
  product_id?: string | null;
  type: string;
  discount_percent?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  weekdays?: number[] | null;
}

export interface OfflinePromotionUpdateInput {
  name?: string;
  description?: string | null;
  scope?: string;
  product_id?: string | null;
  type?: string;
  discount_percent?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  weekdays?: number[] | null;
  enabled?: boolean;
}

export interface OfflinePromotionRow {
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

export interface OfflinePromotionResult {
  success: boolean;
  promotion?: {
    id: string;
    name: string;
    description: string | null;
    scope: string;
    productId: string | null;
    type: string;
    discountPercent: number | null;
    startDate: string | null;
    endDate: string | null;
    weekdays: number[] | null;
    enabled: boolean;
    createdAt: string;
    updatedAt: string;
  };
  error?: string;
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
// Outbox insert helper (shared across create/update/delete)
// ---------------------------------------------------------------------------

function insertPromotionOutbox(
  db: Database.Database,
  opType: string,
  promoId: string,
  payload: unknown,
  createdAt: string,
  installationId: string,
  actorUserId: string | null,
  entityLabel: string,
): void {
  const outboxId = randomUUID();
  const idempotencyKey = `${installationId}:${outboxId}`;

  db.prepare(`
    INSERT INTO outbox
      (id, idempotency_key, operation_type, aggregate_type, aggregate_id,
       payload, status, attempt_count, created_at, updated_at,
       local_device_timestamp, actor_user_id, entity_label)
    VALUES
      (@id, @idempotency_key, @operation_type, 'promotion', @aggregate_id,
       @payload, 'pending', 0, @created_at, @created_at,
       @local_device_timestamp, @actor_user_id, @entity_label)
  `).run({
    id: outboxId,
    idempotency_key: idempotencyKey,
    operation_type: opType,
    aggregate_id: promoId,
    payload: JSON.stringify(payload),
    created_at: createdAt,
    local_device_timestamp: createdAt,
    actor_user_id: actorUserId,
    entity_label: entityLabel,
  });
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export function createOfflinePromotion(
  db: Database.Database,
  input: OfflinePromotionInput,
): OfflinePromotionResult {
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

    insertPromotionOutbox(
      db, "promotion_create", promoId,
      {
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
      createdAt, installationId, actorUserId,
      `Promotion create: ${input.name}`,
    );

    markOfflineWorkRequiresRevalidation(db);
  });

  run();

  const row = db.prepare("SELECT * FROM promotions WHERE id = ?").get(promoId) as OfflinePromotionRow | undefined;
  if (!row) {
    return { success: false, error: "Promotion not found after creation" };
  }

  return { success: true, promotion: mapRow(row) };
}

export function updateOfflinePromotion(
  db: Database.Database,
  promoId: string,
  input: OfflinePromotionUpdateInput,
): OfflinePromotionResult {
  assertOfflineEligible(db);

  const createdAt = now();
  const installationId = getInstallationId(db);
  const actorUserId = getActorUserId(db);

  const existing = db.prepare("SELECT * FROM promotions WHERE id = ?").get(promoId) as OfflinePromotionRow | undefined;
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
      id: promoId,
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

    const payload: Record<string, unknown> = { id: promoId };
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

    insertPromotionOutbox(
      db, "promotion_update", promoId, payload,
      createdAt, installationId, actorUserId,
      `Promotion update: ${promoId.slice(0, 8)}`,
    );

    markOfflineWorkRequiresRevalidation(db);
  });

  run();

  const row = db.prepare("SELECT * FROM promotions WHERE id = ?").get(promoId) as OfflinePromotionRow | undefined;
  if (!row) {
    return { success: false, error: "Promotion not found after update" };
  }

  return { success: true, promotion: mapRow(row) };
}

export function deleteOfflinePromotion(
  db: Database.Database,
  promoId: string,
): OfflinePromotionResult {
  assertOfflineEligible(db);

  const createdAt = now();
  const installationId = getInstallationId(db);
  const actorUserId = getActorUserId(db);

  const existing = db.prepare("SELECT * FROM promotions WHERE id = ?").get(promoId) as OfflinePromotionRow | undefined;
  if (!existing) {
    return { success: false, error: "Promotion not found" };
  }

  // Snapshot for recovery on rejection
  const beforeSnapshot = mapRow(existing)!;

  const run = db.transaction(() => {
    db.prepare("DELETE FROM promotions WHERE id = ?").run(promoId);

    insertPromotionOutbox(
      db, "promotion_delete", promoId,
      {
        id: promoId,
        before: beforeSnapshot,
      },
      createdAt, installationId, actorUserId,
      `Promotion delete: ${beforeSnapshot.name}`,
    );

    markOfflineWorkRequiresRevalidation(db);
  });

  run();

  return { success: true };
}

export function listOfflinePromotions(db: Database.Database): OfflinePromotionResult[] {
  const rows = db.prepare("SELECT * FROM promotions ORDER BY name ASC").all() as OfflinePromotionRow[];
  return rows.map((row) => ({ success: true, promotion: mapRow(row) }));
}
