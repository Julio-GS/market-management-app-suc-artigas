import type Database from "better-sqlite3";
import {
  getOfflineSession,
  unblockAuthEntriesAfterRevalidation,
} from "./offline-auth";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutboxEntryRow {
  id: string;
  idempotency_key: string;
  operation_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: string;
  status: string;
  base_server_version: string | null;
  actor_user_id: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  last_error: string | null;
  server_result: string | null;
  created_at: string;
  updated_at: string;
  synced_at: string | null;
  local_device_timestamp: string | null;
  manual_fix_reason: string | null;
  entity_label: string | null;
}

export interface SyncPushResult {
  id: string;
  idempotency_key: string;
  status: string;
  server_id?: string | null;
  server_version?: string | null;
  reason?: string | null;
  server_payload?: Record<string, unknown> | null;
}

export interface SyncPushResponse {
  results: SyncPushResult[];
}

export interface RevalidateResult {
  valid: boolean;
  user_id: string;
  username?: string;
  reason?: string;
}

export type SyncPushFn = (
  entries: OutboxEntryRow[],
) => Promise<SyncPushResponse>;

export type RevalidateFn = (userId: string) => Promise<RevalidateResult>;

export interface ReplayResult {
  synced: number;
  failed: number;
  blocked: number;
  skipped: number;
  revalidationBlocked: boolean;
}

export interface OutboxStatusCounts {
  pending: number;
  in_flight: number;
  failed: number;
  retry_wait: number;
  blocked_auth: number;
  blocked_conflict: number;
  manual_fix: number;
  synced: number;
}

// ---------------------------------------------------------------------------
// Metadata keys
// ---------------------------------------------------------------------------

const META_REVALIDATE = "revalidation_required";

// ---------------------------------------------------------------------------
// Revalidation flag helpers
// ---------------------------------------------------------------------------

/**
 * Mark that auth revalidation is required before the next privileged sync.
 */
export function markRevalidateRequired(db: Database.Database): void {
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, '1')",
  ).run(META_REVALIDATE);
}

/**
 * Clear the revalidation-required flag after successful revalidation.
 */
export function clearRevalidateRequired(db: Database.Database): void {
  db.prepare(
    "INSERT OR REPLACE INTO metadata (key, value) VALUES (?, '0')",
  ).run(META_REVALIDATE);
}

/**
 * Check whether auth revalidation is required before sync.
 */
export function isRevalidationRequired(db: Database.Database): boolean {
  const row = db
    .prepare("SELECT value FROM metadata WHERE key = ?")
    .get(META_REVALIDATE) as { value: string } | undefined;
  return row?.value === "1";
}

// ---------------------------------------------------------------------------
// Count helpers
// ---------------------------------------------------------------------------

export function getPendingOutboxCount(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'pending'")
    .get() as { c: number };
  return row.c;
}

export function getFailedOutboxCount(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) as c FROM outbox WHERE status = 'failed'")
    .get() as { c: number };
  return row.c;
}

/**
 * Return a count for every recognized outbox status so that sync-state
 * consumers can display pending, in_flight, retry_wait, blocked_auth,
 * blocked_conflict, manual_fix, failed, and synced counts.
 */
export function getOutboxStatusCounts(db: Database.Database): OutboxStatusCounts {
  const rows = db
    .prepare("SELECT status, COUNT(*) as cnt FROM outbox GROUP BY status")
    .all() as { status: string; cnt: number }[];

  const byStatus = new Map(rows.map((r) => [r.status, r.cnt]));

  return {
    pending: byStatus.get("pending") ?? 0,
    in_flight: byStatus.get("in_flight") ?? 0,
    failed: byStatus.get("failed") ?? 0,
    retry_wait: byStatus.get("retry_wait") ?? 0,
    blocked_auth: byStatus.get("blocked_auth") ?? 0,
    blocked_conflict: byStatus.get("blocked_conflict") ?? 0,
    manual_fix: byStatus.get("manual_fix") ?? 0,
    synced: byStatus.get("synced") ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Outbox entry status update
// ---------------------------------------------------------------------------

export interface MarkOutboxOptions {
  status: string;
  last_error?: string | null;
  server_result?: string | null;
  synced_at?: string | null;
  manual_fix_reason?: string | null;
}

/**
 * Reset any outbox entries that are still `in_flight` back to `pending`.
 * This should be called on startup / DB init to recover from a crash that
 * interrupted an in-progress replay.
 *
 * Returns the number of recovered entries.
 */
export function recoverStaleInFlightEntries(db: Database.Database): number {
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE outbox
    SET status = 'pending',
        updated_at = @now
    WHERE status = 'in_flight'
  `).run({ now });
  return result.changes;
}

/**
 * Update a single outbox entry's status and related fields atomically.
 * Increments `attempt_count` on every call.
 */
export function markOutboxEntry(
  db: Database.Database,
  outboxId: string,
  opts: MarkOutboxOptions,
): void {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE outbox
    SET
      status = @status,
      last_error = @last_error,
      server_result = @server_result,
      manual_fix_reason = CASE WHEN @manual_fix_reason IS NOT NULL THEN @manual_fix_reason ELSE manual_fix_reason END,
      synced_at = CASE WHEN @synced_at IS NOT NULL THEN @synced_at ELSE synced_at END,
      attempt_count = attempt_count + 1,
      updated_at = @now
    WHERE id = @id
  `).run({
    id: outboxId,
    status: opts.status,
    last_error: opts.last_error ?? null,
    server_result: opts.server_result ?? null,
    manual_fix_reason: opts.manual_fix_reason ?? null,
    synced_at: opts.synced_at ?? null,
    now,
  });
}

// ---------------------------------------------------------------------------
// Helpers: resolve LWW for product conflicts
// ---------------------------------------------------------------------------

/**
 * Compare the local outbox timestamp against the server-provided version
 * timestamp and decide whether the local write wins.
 *
 * Returns `true` when the local timestamp is strictly later than the server
 * timestamp (local wins), `false` when the server timestamp is later or equal.
 *
 * Returns `null` when either timestamp is missing/invalid — the caller must
 * treat this as `blocked_conflict`.
 */
function resolveLww(
  localTimestamp: string | null,
  serverTimestamp: string | null,
): boolean | null {
  if (!localTimestamp || !serverTimestamp) {
    return null; // missing metadata → blocked_conflict
  }

  const localMs = Date.parse(localTimestamp);
  const serverMs = Date.parse(serverTimestamp);

  if (Number.isNaN(localMs) || Number.isNaN(serverMs)) {
    return null; // unparseable → blocked_conflict
  }

  return localMs > serverMs;
}

/**
 * @deprecated Use the generic resolveLww instead.
 */
function resolveProductLww(
  localTimestamp: string | null,
  serverTimestamp: string | null,
): boolean | null {
  return resolveLww(localTimestamp, serverTimestamp);
}

// ---------------------------------------------------------------------------
// Helpers: apply server-won product payload locally
// ---------------------------------------------------------------------------

/**
 * Apply a server-won product payload to the local products table.
 *
 * Only updates fields present in the payload; leaves other columns unchanged.
 * Upserts the row so products that don't exist locally yet are created.
 */
function applyServerProductPayload(
  db: Database.Database,
  payload: Record<string, unknown>,
): void {
  const id = payload.id as string | undefined;
  if (!id) return;

  const now = new Date().toISOString();

  // Check if product exists locally
  const existing = db.prepare("SELECT id FROM products WHERE id = ?").get(id);

  if (existing) {
    // Update only fields present in the server payload
    const fields: string[] = [];
    const values: Record<string, unknown> = { id, updated_at: now };

    if (payload.detalle !== undefined) { fields.push("detalle = @detalle"); values.detalle = payload.detalle; }
    if (payload.costo_neto !== undefined) { fields.push("costo_neto = @costo_neto"); values.costo_neto = payload.costo_neto; }
    if (payload.costo_final !== undefined) { fields.push("costo_final = @costo_final"); values.costo_final = payload.costo_final; }
    if (payload.iva !== undefined) { fields.push("iva = @iva"); values.iva = payload.iva; }
    if (payload.cambio_costo !== undefined) { fields.push("cambio_costo = @cambio_costo"); values.cambio_costo = payload.cambio_costo; }
    if (payload.cambio_precio !== undefined) { fields.push("cambio_precio = @cambio_precio"); values.cambio_precio = payload.cambio_precio; }
    if (payload.etiqueta !== undefined) { fields.push("etiqueta = @etiqueta"); values.etiqueta = payload.etiqueta; }
    if (payload.facturable !== undefined) { fields.push("facturable = @facturable"); values.facturable = payload.facturable ? 1 : 0; }
    if (payload.maneja_stock !== undefined) { fields.push("maneja_stock = @maneja_stock"); values.maneja_stock = payload.maneja_stock ? 1 : 0; }
    if (payload.codigos !== undefined) { fields.push("codigos = @codigos"); values.codigos = JSON.stringify(payload.codigos); }
    if (payload.is_protected !== undefined) { fields.push("is_protected = @is_protected"); values.is_protected = payload.is_protected ? 1 : 0; }

    if (fields.length > 0) {
      fields.push("updated_at = @updated_at");
      db.prepare(`UPDATE products SET ${fields.join(", ")} WHERE id = @id`).run(values);
    }
  } else {
    // Insert new product from server payload
    db.prepare(`
      INSERT INTO products
        (id, detalle, costo_neto, costo_final, iva, cambio_costo, cambio_precio,
         etiqueta, facturable, maneja_stock, codigos, pricing_mode, is_protected,
         created_at, updated_at)
      VALUES
        (@id, @detalle, @costo_neto, @costo_final, @iva, @cambio_costo, @cambio_precio,
         @etiqueta, @facturable, @maneja_stock, @codigos, @pricing_mode, @is_protected,
         @created_at, @updated_at)
    `).run({
      id,
      detalle: (payload.detalle as string) ?? "",
      costo_neto: (payload.costo_neto as string) ?? null,
      costo_final: (payload.costo_final as string) ?? null,
      iva: (payload.iva as string) ?? null,
      cambio_costo: (payload.cambio_costo as string) ?? "fixed",
      cambio_precio: (payload.cambio_precio as string) ?? "fixed",
      etiqueta: (payload.etiqueta as string) ?? "",
      facturable: payload.facturable !== false ? 1 : 0,
      maneja_stock: payload.maneja_stock !== false ? 1 : 0,
      codigos: JSON.stringify(payload.codigos ?? []),
      pricing_mode: (payload.pricing_mode as string) ?? "fixed",
      is_protected: payload.is_protected ? 1 : 0,
      created_at: (payload.created_at as string) ?? now,
      updated_at: (payload.updated_at as string) ?? now,
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers: restore product from delete before-snapshot
// ---------------------------------------------------------------------------

/**
 * Restore a product that was locally deleted but whose delete operation was
 * definitively rejected by the server. Re-inserts the product row from the
 * `before` snapshot stored in the outbox payload.
 */
function restoreProductFromSnapshot(
  db: Database.Database,
  snapshot: Record<string, unknown>,
): void {
  const id = snapshot.id as string | undefined;
  if (!id) return;

  // Only restore if product does NOT already exist (it was deleted)
  const existing = db.prepare("SELECT id FROM products WHERE id = ?").get(id);
  if (existing) return;

  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO products
      (id, detalle, costo_neto, costo_final, iva, cambio_costo, cambio_precio,
       etiqueta, facturable, maneja_stock, codigos, pricing_mode, is_protected,
       created_at, updated_at)
    VALUES
      (@id, @detalle, @costo_neto, @costo_final, @iva, @cambio_costo, @cambio_precio,
       @etiqueta, @facturable, @maneja_stock, @codigos, @pricing_mode, @is_protected,
       @created_at, @updated_at)
  `).run({
    id,
    detalle: (snapshot.detalle as string) ?? "",
    costo_neto: (snapshot.costoNeto ?? snapshot.costo_neto) as string | null ?? null,
    costo_final: (snapshot.costoFinal ?? snapshot.costo_final) as string | null ?? null,
    iva: (snapshot.iva as string) ?? null,
    cambio_costo: (snapshot.cambioCosto ?? snapshot.cambio_costo as string) ?? "fixed",
    cambio_precio: (snapshot.cambioPrecio ?? snapshot.cambio_precio as string) ?? "fixed",
    etiqueta: (snapshot.etiqueta as string) ?? "",
    facturable: snapshot.facturable !== false ? 1 : 0,
    maneja_stock: snapshot.manejaStock !== false ? 1 : 0,
    codigos: JSON.stringify(snapshot.codigos ?? []),
    pricing_mode: (snapshot.pricingMode ?? snapshot.pricing_mode as string) ?? "fixed",
    is_protected: snapshot.is_protected ? 1 : 0,
    created_at: (snapshot.createdAt ?? snapshot.created_at as string) ?? now,
    updated_at: (snapshot.updatedAt ?? snapshot.updated_at as string) ?? now,
  });
}

// ---------------------------------------------------------------------------
// Helpers: promotion LWW apply/restore
// ---------------------------------------------------------------------------

/**
 * Apply a server-won promotion payload to the local promotions table.
 */
function applyServerPromotionPayload(
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
function restorePromotionFromSnapshot(
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

// ---------------------------------------------------------------------------
// Helpers: provider purchase LWW apply/restore
// ---------------------------------------------------------------------------

/**
 * Apply a server-won provider purchase payload to the local table.
 */
function applyServerProviderPurchasePayload(
  db: Database.Database,
  payload: Record<string, unknown>,
): void {
  const id = payload.id as string | undefined;
  if (!id) return;

  const existing = db.prepare("SELECT id FROM provider_purchases WHERE id = ?").get(id);

  if (existing) {
    const fields: string[] = [];
    const values: Record<string, unknown> = { id };

    if (payload.provider_name !== undefined) { fields.push("provider_name = @provider_name"); values.provider_name = payload.provider_name; }
    if (payload.amount !== undefined) { fields.push("amount = @amount"); values.amount = payload.amount; }
    if (payload.payment_method !== undefined) { fields.push("payment_method = @payment_method"); values.payment_method = payload.payment_method; }

    if (fields.length > 0) {
      fields.push("updated_at = @updated_at");
      values.updated_at = new Date().toISOString();
      db.prepare(`UPDATE provider_purchases SET ${fields.join(", ")} WHERE id = @id`).run(values);
    }
  } else {
    db.prepare(`
      INSERT INTO provider_purchases
        (id, provider_name, amount, payment_method, created_at, updated_at)
      VALUES
        (@id, @provider_name, @amount, @payment_method, @created_at, @updated_at)
    `).run({
      id,
      provider_name: (payload.provider_name as string) ?? "",
      amount: (payload.amount as string) ?? "0.00",
      payment_method: (payload.payment_method as string) ?? null,
      created_at: (payload.created_at as string) ?? new Date().toISOString(),
      updated_at: (payload.updated_at as string) ?? new Date().toISOString(),
    });
  }
}

/**
 * Restore a provider purchase that was locally deleted but whose delete
 * operation was definitively rejected by the server.
 */
function restoreProviderPurchaseFromSnapshot(
  db: Database.Database,
  snapshot: Record<string, unknown>,
): void {
  const id = snapshot.id as string | undefined;
  if (!id) return;

  const existing = db.prepare("SELECT id FROM provider_purchases WHERE id = ?").get(id);
  if (existing) return;

  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO provider_purchases
      (id, provider_name, amount, payment_method, created_at, updated_at)
    VALUES
      (@id, @provider_name, @amount, @payment_method, @created_at, @updated_at)
  `).run({
    id,
    provider_name: (snapshot.providerName ?? snapshot.provider_name as string) ?? "",
    amount: (snapshot.amount as string) ?? "0.00",
    payment_method: (snapshot.paymentMethod ?? snapshot.payment_method as string) ?? null,
    created_at: (snapshot.createdAt ?? snapshot.created_at as string) ?? now,
    updated_at: (snapshot.updatedAt ?? snapshot.updated_at as string) ?? now,
  });
}

// ---------------------------------------------------------------------------
// Ordered outbox replay
// ---------------------------------------------------------------------------

/**
 * Replay pending outbox entries in order.
 *
 * - Skips already-synced/failed entries.
 * - If auth revalidation is required, uses `getOfflineSession` (deterministic)
 *   to choose the revalidation actor and runs `revalidateFn` first.
 * - On successful revalidation, calls `unblockAuthEntriesAfterRevalidation`
 *   so previously `blocked_auth` entries for the revalidated actor return to
 *   `pending` for ordered replay.
 * - Pushes pending entries in a batch via `pushFn`.
 * - Processes per-entry results:
 *   - `validation_error` → `manual_fix` (definitive rejection, not retryable);
 *     for `product_delete` restores the product from the `before` snapshot.
 *   - `conflict` for product types → LWW resolution by `local_device_timestamp`:
 *     local wins → re-queue as `pending` with LWW metadata for re-push;
 *     server wins → apply server payload locally, mark `synced`.
 *   - `conflict` for non-product types → `blocked_conflict`
 *   - `conflict` with missing metadata → `blocked_conflict`
 *   - `auth_blocked` / `blocked` → `blocked_auth`
 *   - `transient_error` → `retry_wait`
 * - On blocking failure, marks later entries as pending (not pushed further).
 */
export async function replayOutbox(
  db: Database.Database,
  pushFn: SyncPushFn,
  revalidateFn: RevalidateFn,
): Promise<ReplayResult> {
  const result: ReplayResult = {
    synced: 0,
    failed: 0,
    blocked: 0,
    skipped: 0,
    revalidationBlocked: false,
  };

  // -------------------------------------------------------------------
  // 1. Auth revalidation gate
  // -------------------------------------------------------------------
  if (isRevalidationRequired(db)) {
    // Use the deterministic most-recently-validated session helper
    const session = getOfflineSession(db);

    if (!session) {
      result.revalidationBlocked = true;
      return result;
    }

    const reval = await revalidateFn(session.user_id);
    if (!reval.valid) {
      result.revalidationBlocked = true;

      // Mark all pending entries as blocked_auth
      db.prepare(`
        UPDATE outbox
        SET status = 'blocked_auth',
            last_error = @reason,
            updated_at = @now
        WHERE status = 'pending'
      `).run({
        reason: reval.reason ?? "Auth revalidation failed",
        now: new Date().toISOString(),
      });

      return result;
    }

    // Unblock previously blocked_auth entries for this actor only
    unblockAuthEntriesAfterRevalidation(db, session.user_id);
  }

  // -------------------------------------------------------------------
  // 2. Collect pending entries in order
  // -------------------------------------------------------------------
  const pending = db
    .prepare(
      "SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC",
    )
    .all() as OutboxEntryRow[];

  if (pending.length === 0) {
    return result;
  }

  // -------------------------------------------------------------------
  // 3. Mark collected entries as in_flight before pushing
  // -------------------------------------------------------------------
  const now = new Date().toISOString();
  const markInFlight = db.prepare(`
    UPDATE outbox
    SET status = 'in_flight', updated_at = ?
    WHERE id = ?
  `);
  for (const e of pending) {
    markInFlight.run(now, e.id);
  }

  // -------------------------------------------------------------------
  // 4. Push batch
  // -------------------------------------------------------------------
  let pushResponse: SyncPushResponse;
  try {
    pushResponse = await pushFn(pending);
  } catch (err) {
    // Network-level failure — mark all as retry_wait
    const reason = err instanceof Error ? err.message : String(err);
    for (const entry of pending) {
      markOutboxEntry(db, entry.id, {
        status: "retry_wait",
        last_error: reason,
      });
    }
    result.failed = pending.length;
    return result;
  }

  // -------------------------------------------------------------------
  // 5. Process per-entry results
  // -------------------------------------------------------------------
  let blocked = false;

  for (let i = 0; i < pending.length; i++) {
    const entry = pending[i];
    const entryResult = pushResponse.results[i];

    if (blocked) {
      // Later entries remain pending
      markOutboxEntry(db, entry.id, {
        status: "pending",
        last_error: "Blocked by a previous entry failure.",
      });
      result.blocked += 1;
      continue;
    }

    if (!entryResult) {
      markOutboxEntry(db, entry.id, {
        status: "failed",
        last_error: "No result returned from server for this entry.",
      });
      result.failed += 1;
      blocked = true;
      continue;
    }

    switch (entryResult.status) {
      case "accepted":
      case "duplicate":
        markOutboxEntry(db, entry.id, {
          status: "synced",
          synced_at: new Date().toISOString(),
          server_result: JSON.stringify(entryResult),
        });
        result.synced += 1;
        break;

      // -- definitive rejection → manual_fix (GAP 1, GAP 4, GAP 6) ----------
      case "validation_error": {
        const reason = entryResult.reason ?? "Server rejected the operation.";

        // GAP 4: product_delete definitive rejection → restore product from before snapshot
        if (entry.operation_type === "product_delete") {
          try {
            const payload = JSON.parse(entry.payload);
            if (payload.before) {
              restoreProductFromSnapshot(db, payload.before);
            }
          } catch {
            // If payload is unparseable, still mark manual_fix without restore
          }
        }

        // promotion_delete definitive rejection → restore from before snapshot
        if (entry.operation_type === "promotion_delete") {
          try {
            const payload = JSON.parse(entry.payload);
            if (payload.before) {
              restorePromotionFromSnapshot(db, payload.before);
            }
          } catch {
            // best-effort
          }
        }

        // provider_purchase_delete definitive rejection → restore from before snapshot
        if (entry.operation_type === "provider_purchase_delete") {
          try {
            const payload = JSON.parse(entry.payload);
            if (payload.before) {
              restoreProviderPurchaseFromSnapshot(db, payload.before);
            }
          } catch {
            // best-effort
          }
        }

        markOutboxEntry(db, entry.id, {
          status: "manual_fix",
          last_error: reason,
          manual_fix_reason: reason,
          server_result: JSON.stringify(entryResult),
        });
        result.failed += 1;
        blocked = true;
        break;
      }

      // -- product/promotion/provider_purchase LWW conflict resolution ---------
      case "conflict":
        if (
          entry.aggregate_type === "product" ||
          entry.aggregate_type === "promotion" ||
          entry.aggregate_type === "provider_purchase"
        ) {
          const localTs = entry.local_device_timestamp ?? entry.created_at;
          const serverTs = entryResult.server_version ?? null;

          const lwwResult = resolveLww(localTs, serverTs);

          if (lwwResult === null) {
            // Missing or invalid conflict metadata
            markOutboxEntry(db, entry.id, {
              status: "blocked_conflict",
              last_error:
                entryResult.reason ??
                `${entry.aggregate_type} conflict could not be resolved — missing or invalid timestamp metadata.`,
              server_result: JSON.stringify(entryResult),
            });
            result.blocked += 1;
            blocked = true;
          } else if (lwwResult) {
            // Local wins → re-queue as pending with LWW metadata for re-push
            try {
              const existingPayload = JSON.parse(entry.payload);
              const updatedPayload = {
                ...existingPayload,
                lww_resolution: "local_wins",
                local_device_timestamp: localTs,
              };
              db.prepare(`
                UPDATE outbox
                SET status = 'pending',
                    payload = @payload,
                    last_error = @last_error,
                    server_result = @server_result,
                    attempt_count = attempt_count + 1,
                    updated_at = @now
                WHERE id = @id
              `).run({
                id: entry.id,
                payload: JSON.stringify(updatedPayload),
                last_error: entryResult.reason ?? null,
                server_result: JSON.stringify({
                  ...entryResult,
                  lww_resolution: "local_wins",
                }),
                now: new Date().toISOString(),
              });
            } catch {
              markOutboxEntry(db, entry.id, {
                status: "pending",
                last_error: entryResult.reason ?? null,
                server_result: JSON.stringify(entryResult),
              });
            }
            result.failed += 1;
          } else {
            // Server wins → apply server payload locally
            if (entryResult.server_payload) {
              if (entry.aggregate_type === "promotion") {
                applyServerPromotionPayload(db, entryResult.server_payload);
              } else if (entry.aggregate_type === "provider_purchase") {
                applyServerProviderPurchasePayload(db, entryResult.server_payload);
              } else {
                applyServerProductPayload(db, entryResult.server_payload);
              }
            }
            markOutboxEntry(db, entry.id, {
              status: "synced",
              synced_at: new Date().toISOString(),
              server_result: JSON.stringify({
                ...entryResult,
                lww_resolution: "server_wins",
              }),
            });
            result.synced += 1;
          }
        } else {
          // Non-LWW conflict → blocked_conflict
          markOutboxEntry(db, entry.id, {
            status: "blocked_conflict",
            last_error: entryResult.reason ?? "Unresolved conflict on non-LWW entity.",
            server_result: JSON.stringify(entryResult),
          });
          result.blocked += 1;
          blocked = true;
        }
        break;

      case "transient_error":
        markOutboxEntry(db, entry.id, {
          status: "retry_wait",
          last_error: entryResult.reason ?? "Transient server error.",
          server_result: JSON.stringify(entryResult),
        });
        result.failed += 1;
        blocked = true;
        break;

      // -- auth_blocked / blocked → blocked_auth (GAP 5) --------------------
      case "auth_blocked":
      case "blocked":
        markOutboxEntry(db, entry.id, {
          status: "blocked_auth",
          last_error: entryResult.reason ?? "Blocked by server.",
          server_result: JSON.stringify(entryResult),
        });
        result.blocked += 1;
        break;

      default:
        markOutboxEntry(db, entry.id, {
          status: "failed",
          last_error: `Unknown server status: ${entryResult.status}`,
          server_result: JSON.stringify(entryResult),
        });
        result.failed += 1;
        blocked = true;
    }
  }

  return result;
}
