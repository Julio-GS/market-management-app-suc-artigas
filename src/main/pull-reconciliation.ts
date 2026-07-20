import type Database from "better-sqlite3";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PullChange {
  id: string;
  aggregate_type: "product" | "promotion" | "provider_purchase" | "stock";
  operation_type: string;
  server_version: string;
  server_applied_at: string;
  payload: unknown;
  deleted?: boolean;
}

export interface PullResponse {
  changes: PullChange[];
  cursor: string;
  has_more: boolean;
}

export type PullFn = (cursor?: string) => Promise<PullResponse>;

export interface PullResult {
  applied: number;
  skipped: number;
  cursor: string | null;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

export function getSyncCursor(db: Database.Database): string | null {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = 'sync_cursor'")
    .get() as { value: string } | undefined;
  return row?.value || null;
}

function setSyncCursor(db: Database.Database, cursor: string): void {
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('sync_cursor', ?)",
  ).run(cursor);
}

export function setLastSyncAt(db: Database.Database): void {
  const now = new Date().toISOString();
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES ('last_sync_at', ?)",
  ).run(now);
}

// ---------------------------------------------------------------------------
// Apply helpers — update local stores with server-authoritative data
// ---------------------------------------------------------------------------

function applyProduct(db: Database.Database, change: PullChange): boolean {
  const payload = change.payload as Record<string, unknown>;

  if (change.deleted) {
    const existing = db
      .prepare("SELECT id FROM products WHERE id = ?")
      .get(change.id);
    if (!existing) return true; // idempotent — already deleted
    db.prepare("DELETE FROM products WHERE id = ?").run(change.id);
    return true;
  }

  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id FROM products WHERE id = ?")
    .get(change.id);

  if (existing) {
    db.prepare(`
      UPDATE products SET
        detalle = COALESCE(@detalle, detalle),
        costo_neto = COALESCE(@costo_neto, costo_neto),
        costo_final = COALESCE(@costo_final, costo_final),
        iva = COALESCE(@iva, iva),
        cambio_costo = COALESCE(@cambio_costo, cambio_costo),
        cambio_precio = COALESCE(@cambio_precio, cambio_precio),
        etiqueta = COALESCE(@etiqueta, etiqueta),
        facturable = COALESCE(@facturable, facturable),
        maneja_stock = COALESCE(@maneja_stock, maneja_stock),
        codigos = COALESCE(@codigos, codigos),
        updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: change.id,
      detalle: payload.detalle ?? null,
      costo_neto: payload.costo_neto ?? null,
      costo_final: payload.costo_final ?? null,
      iva: payload.iva ?? null,
      cambio_costo: payload.cambio_costo ?? null,
      cambio_precio: payload.cambio_precio ?? null,
      etiqueta: payload.etiqueta ?? null,
      facturable: payload.facturable !== undefined ? (payload.facturable ? 1 : 0) : null,
      maneja_stock: payload.maneja_stock !== undefined ? (payload.maneja_stock ? 1 : 0) : null,
      codigos: payload.codigos ? JSON.stringify(payload.codigos) : null,
      updated_at: now,
    });
  } else {
    db.prepare(`
      INSERT INTO products
        (id, detalle, costo_neto, costo_final, iva, cambio_costo, cambio_precio,
         etiqueta, facturable, maneja_stock, codigos, pricing_mode, is_protected,
         created_at, updated_at)
      VALUES
        (@id, @detalle, @costo_neto, @costo_final, @iva, @cambio_costo, @cambio_precio,
         @etiqueta, @facturable, @maneja_stock, @codigos, @pricing_mode, 0,
         @created_at, @created_at)
    `).run({
      id: change.id,
      detalle: payload.detalle ?? "",
      costo_neto: payload.costo_neto ?? null,
      costo_final: payload.costo_final ?? null,
      iva: payload.iva ?? null,
      cambio_costo: (payload.cambio_costo as string) ?? "fixed",
      cambio_precio: (payload.cambio_precio as string) ?? "fixed",
      etiqueta: (payload.etiqueta as string) ?? "",
      facturable: payload.facturable !== false ? 1 : 0,
      maneja_stock: payload.maneja_stock !== false ? 1 : 0,
      codigos: JSON.stringify(payload.codigos ?? []),
      pricing_mode: (payload.pricing_mode as string) ?? "fixed",
      created_at: now,
    });
  }

  return true;
}

function applyPromotion(db: Database.Database, change: PullChange): boolean {
  const payload = change.payload as Record<string, unknown>;

  if (change.deleted) {
    const existing = db
      .prepare("SELECT id FROM promotions WHERE id = ?")
      .get(change.id);
    if (!existing) return true; // idempotent
    db.prepare("DELETE FROM promotions WHERE id = ?").run(change.id);
    return true;
  }

  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id FROM promotions WHERE id = ?")
    .get(change.id);

  if (existing) {
    db.prepare(`
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
    `).run({
      id: change.id,
      name: payload.name ?? null,
      description: payload.description !== undefined ? payload.description : null,
      scope: payload.scope ?? null,
      product_id: payload.product_id !== undefined ? payload.product_id : null,
      type: payload.type ?? null,
      discount_percent: payload.discount_percent !== undefined ? payload.discount_percent : null,
      start_date: payload.start_date !== undefined ? payload.start_date : null,
      end_date: payload.end_date !== undefined ? payload.end_date : null,
      weekdays: payload.weekdays !== undefined ? (payload.weekdays ? JSON.stringify(payload.weekdays) : null) : null,
      enabled: payload.enabled !== undefined ? (payload.enabled ? 1 : 0) : null,
      updated_at: now,
    });
  } else {
    db.prepare(`
      INSERT INTO promotions
        (id, name, description, scope, product_id, type, discount_percent,
         start_date, end_date, weekdays, enabled, created_at, updated_at)
      VALUES
        (@id, @name, @description, @scope, @product_id, @type, @discount_percent,
         @start_date, @end_date, @weekdays, 1, @created_at, @created_at)
    `).run({
      id: change.id,
      name: payload.name ?? "",
      description: payload.description ?? null,
      scope: payload.scope ?? "product",
      product_id: payload.product_id ?? null,
      type: payload.type ?? "percentage",
      discount_percent: payload.discount_percent ?? null,
      start_date: payload.start_date ?? null,
      end_date: payload.end_date ?? null,
      weekdays: payload.weekdays ? JSON.stringify(payload.weekdays) : null,
      created_at: now,
    });
  }

  return true;
}

function applyProviderPurchase(db: Database.Database, change: PullChange): boolean {
  const payload = change.payload as Record<string, unknown>;

  if (change.deleted) {
    const existing = db
      .prepare("SELECT id FROM provider_purchases WHERE id = ?")
      .get(change.id);
    if (!existing) return true; // idempotent
    db.prepare("DELETE FROM provider_purchases WHERE id = ?").run(change.id);
    return true;
  }

  const now = new Date().toISOString();
  const existing = db
    .prepare("SELECT id FROM provider_purchases WHERE id = ?")
    .get(change.id);

  if (existing) {
    db.prepare(`
      UPDATE provider_purchases SET
        provider_name = COALESCE(@provider_name, provider_name),
        amount = COALESCE(@amount, amount),
        payment_method = COALESCE(@payment_method, payment_method),
        updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: change.id,
      provider_name: payload.provider_name ?? null,
      amount: payload.amount ?? null,
      payment_method: payload.payment_method !== undefined ? payload.payment_method : null,
      updated_at: now,
    });
  } else {
    db.prepare(`
      INSERT INTO provider_purchases
        (id, provider_name, amount, payment_method, created_at, updated_at)
      VALUES
        (@id, @provider_name, @amount, @payment_method, @created_at, @created_at)
    `).run({
      id: change.id,
      provider_name: payload.provider_name ?? "",
      amount: payload.amount ?? "0",
      payment_method: payload.payment_method ?? null,
      created_at: now,
    });
  }

  return true;
}

function applyStockBalance(db: Database.Database, change: PullChange): boolean {
  const payload = change.payload as Record<string, unknown>;
  const productId = payload.product_id as string;
  const stockActual = payload.stock_actual as number;
  const updatedAt = (payload.updated_at as string) ?? new Date().toISOString();

  if (productId === undefined || stockActual === undefined) return false;

  const existing = db
    .prepare("SELECT product_id FROM stock_balances WHERE product_id = ?")
    .get(productId);

  if (existing) {
    db.prepare(`
      UPDATE stock_balances SET stock_actual = @stock, updated_at = @updated_at
      WHERE product_id = @product_id
    `).run({ product_id: productId, stock: stockActual, updated_at: updatedAt });
  } else {
    db.prepare(`
      INSERT INTO stock_balances (product_id, stock_actual, updated_at)
      VALUES (@product_id, @stock, @updated_at)
    `).run({ product_id: productId, stock: stockActual, updated_at: updatedAt });
  }

  return true;
}

// ---------------------------------------------------------------------------
// Pull engine
// ---------------------------------------------------------------------------

/**
 * Pull server-authoritative changes and apply them to local stores.
 *
 * Applies each change to the appropriate local table.  The sync cursor is
 * ONLY advanced when every change in the batch is successfully applied (or is
 * idempotent — e.g. deleting an already-deleted record).  Unknown aggregate
 * types and failed applies stop processing immediately without advancing the
 * cursor.
 */
export async function pullAndApply(
  db: Database.Database,
  pullFn: PullFn,
): Promise<PullResult> {
  const result: PullResult = {
    applied: 0,
    skipped: 0,
    cursor: null,
    hasMore: false,
  };

  const cursor = getSyncCursor(db);

  let response: PullResponse;
  try {
    response = await pullFn(cursor ?? undefined);
  } catch {
    // Network-level / caller failure — leave cursor unchanged so caller can retry
    return result;
  }

  const run = db.transaction(() => {
    for (const change of response.changes) {
      let applied = false;
      let supported = true;

      switch (change.aggregate_type) {
        case "product":
          applied = applyProduct(db, change);
          break;
        case "promotion":
          applied = applyPromotion(db, change);
          break;
        case "provider_purchase":
          applied = applyProviderPurchase(db, change);
          break;
        case "stock":
          applied = applyStockBalance(db, change);
          break;
        default:
          supported = false;
          break;
      }

      if (!supported) {
        // Unknown aggregate type — do NOT advance cursor past this record.
        result.skipped += 1;
        break;
      }

      if (applied) {
        result.applied += 1;
      } else {
        // Supported but could not be applied (e.g. stock payload missing
        // required fields).  Stop so cursor is not advanced past an
        // unhandled record.
        result.skipped += 1;
        break;
      }
    }

    // Only advance the cursor when the entire batch was consumed without
    // unsupported or failed records.  This preserves the cursor safety
    // invariant: the cursor must never pass a record that was skipped.
    if (result.skipped === 0) {
      setSyncCursor(db, response.cursor);
      setLastSyncAt(db);
    }
  });

  run();

  result.cursor = result.skipped === 0 ? response.cursor : cursor;
  result.hasMore = response.has_more;

  return result;
}
