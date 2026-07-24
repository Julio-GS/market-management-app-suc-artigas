// ---------------------------------------------------------------------------
// Promotion payload apply / restore helpers
//
// Extracted from src/main/sync-engine.ts — logic preserved verbatim.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";

/**
 * Apply a server-won promotion payload to the local promotions table.
 */
export function applyServerPromotionPayload(
  db: Database.Database,
  payload: Record<string, unknown>,
): void {
  const id = payload.id as string | undefined;
  if (!id) return;

  const existing = db.prepare("SELECT id FROM promotions WHERE id = ?").get(id);

  if (existing) {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (payload.name !== undefined) { fields.push("name = @name"); values.name = payload.name; }
    if (payload.description !== undefined) { fields.push("description = @description"); values.description = payload.description; }
    if (payload.scope !== undefined) { fields.push("scope = @scope"); values.scope = payload.scope; }
    if (payload.product_id !== undefined) { fields.push("product_id = @product_id"); values.product_id = payload.product_id; }
    if (payload.type !== undefined) { fields.push("type = @type"); values.type = payload.type; }
    if (payload.discount_percent !== undefined) { fields.push("discount_percent = @discount_percent"); values.discount_percent = payload.discount_percent; }
    if (payload.start_date !== undefined) { fields.push("start_date = @start_date"); values.start_date = payload.start_date; }
    if (payload.end_date !== undefined) { fields.push("end_date = @end_date"); values.end_date = payload.end_date; }
    if (payload.weekdays !== undefined) { fields.push("weekdays = @weekdays"); values.weekdays = payload.weekdays ? JSON.stringify(payload.weekdays) : null; }
    if (payload.enabled !== undefined) { fields.push("enabled = @enabled"); values.enabled = payload.enabled ? 1 : 0; }

    if (fields.length > 0) {
      fields.push("updated_at = @updated_at");
      values.updated_at = new Date().toISOString();
      db.prepare(`UPDATE promotions SET ${fields.join(", ")} WHERE id = @id`).run(values);
    }
  } else {
    db.prepare(`
      INSERT INTO promotions
        (id, name, description, scope, product_id, type, discount_percent,
         start_date, end_date, weekdays, enabled, created_at, updated_at)
      VALUES
        (@id, @name, @description, @scope, @product_id, @type, @discount_percent,
         @start_date, @end_date, @weekdays, @enabled, @created_at, @updated_at)
    `).run({
      id,
      name: (payload.name as string) ?? "",
      description: (payload.description as string) ?? null,
      scope: (payload.scope as string) ?? "product",
      product_id: (payload.product_id as string) ?? null,
      type: (payload.type as string) ?? "percentage",
      discount_percent: (payload.discount_percent as number) ?? null,
      start_date: (payload.start_date as string) ?? null,
      end_date: (payload.end_date as string) ?? null,
      weekdays: payload.weekdays ? JSON.stringify(payload.weekdays) : null,
      enabled: payload.enabled !== false ? 1 : 0,
      created_at: (payload.created_at as string) ?? new Date().toISOString(),
      updated_at: (payload.updated_at as string) ?? new Date().toISOString(),
    });
  }
}

/**
 * Restore a promotion that was locally deleted but whose delete operation
 * was definitively rejected by the server.
 */
export function restorePromotionFromSnapshot(
  db: Database.Database,
  snapshot: Record<string, unknown>,
): void {
  const id = snapshot.id as string | undefined;
  if (!id) return;

  const existing = db.prepare("SELECT id FROM promotions WHERE id = ?").get(id);
  if (existing) return;

  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO promotions
      (id, name, description, scope, product_id, type, discount_percent,
       start_date, end_date, weekdays, enabled, created_at, updated_at)
    VALUES
      (@id, @name, @description, @scope, @product_id, @type, @discount_percent,
       @start_date, @end_date, @weekdays, @enabled, @created_at, @updated_at)
  `).run({
    id,
    name: (snapshot.name as string) ?? "",
    description: (snapshot.description as string) ?? null,
    scope: (snapshot.scope as string) ?? "product",
    product_id: (snapshot.productId ?? snapshot.product_id as string) ?? null,
    type: (snapshot.type as string) ?? "percentage",
    discount_percent: (snapshot.discountPercent ?? snapshot.discount_percent as number) ?? null,
    start_date: (snapshot.startDate ?? snapshot.start_date as string) ?? null,
    end_date: (snapshot.endDate ?? snapshot.end_date as string) ?? null,
    weekdays: snapshot.weekdays ? JSON.stringify(snapshot.weekdays) : null,
    enabled: snapshot.enabled !== false ? 1 : 0,
    created_at: (snapshot.createdAt ?? snapshot.created_at as string) ?? now,
    updated_at: (snapshot.updatedAt ?? snapshot.updated_at as string) ?? now,
  });
}
