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

export interface OfflineProductInput {
  detalle: string;
  costo_neto?: string | null;
  costo_final?: string | null;
  iva?: string | null;
  cambio_costo?: string;
  cambio_precio?: string;
  etiqueta?: string;
  facturable?: boolean;
  maneja_stock?: boolean;
  codigos?: string[];
}

export interface OfflineProductUpdateInput {
  detalle?: string;
  costo_neto?: string | null;
  costo_final?: string | null;
  iva?: string | null;
  cambio_costo?: string;
  cambio_precio?: string;
  etiqueta?: string;
  facturable?: boolean;
  maneja_stock?: boolean;
  codigos?: string[];
}

export interface OfflineProductRow {
  id: string;
  detalle: string;
  costo_neto: string | null;
  costo_final: string | null;
  iva: string | null;
  cambio_costo: string;
  cambio_precio: string;
  etiqueta: string;
  facturable: number;
  maneja_stock: number;
  codigos: string;
  pricing_mode: string;
  is_protected: number;
  created_at: string;
  updated_at: string;
}

export interface OfflineProductResult {
  success: boolean;
  product?: {
    id: string;
    detalle: string;
    costoNeto: string | null;
    costoFinal: string | null;
    iva: string | null;
    cambioCosto: string;
    cambioPrecio: string;
    etiqueta: string;
    facturable: boolean;
    manejaStock: boolean;
    codigos: string[];
    pricingMode: string;
    createdAt: string;
    updatedAt: string;
  };
  error?: string;
  errorCode?: string;
}

export class ProtectedProductError extends Error {
  constructor(productId: string) {
    super(`Cannot delete protected product ${productId}. Protected products are server-managed.`);
    this.name = "ProtectedProductError";
  }
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

export function sanitizeProductCodes(codigos: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(codigos)) {
    return [];
  }

  const seen = new Set<string>();
  const sanitized: string[] = [];

  for (const code of codigos) {
    if (typeof code !== "string") {
      continue;
    }

    const trimmed = code.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    sanitized.push(trimmed);
  }

  return sanitized;
}

function mapRow(row: OfflineProductRow): OfflineProductResult["product"] {
  return {
    id: row.id,
    detalle: row.detalle,
    costoNeto: row.costo_neto,
    costoFinal: row.costo_final,
    iva: row.iva,
    cambioCosto: row.cambio_costo,
    cambioPrecio: row.cambio_precio,
    etiqueta: row.etiqueta,
    facturable: row.facturable === 1,
    manejaStock: row.maneja_stock === 1,
    codigos: JSON.parse(row.codigos || "[]"),
    pricingMode: row.pricing_mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Outbox insert helper (shared across create/update/delete)
// ---------------------------------------------------------------------------

function insertProductOutbox(
  db: Database.Database,
  opType: string,
  productId: string,
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
      (@id, @idempotency_key, @operation_type, 'product', @aggregate_id,
       @payload, 'pending', 0, @created_at, @created_at,
       @local_device_timestamp, @actor_user_id, @entity_label)
  `).run({
    id: outboxId,
    idempotency_key: idempotencyKey,
    operation_type: opType,
    aggregate_id: productId,
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

/**
 * Create a product locally and enqueue an outbox entry in the same transaction.
 * Requires a cached offline session (auth guard).
 */
export function createOfflineProduct(
  db: Database.Database,
  input: OfflineProductInput,
): OfflineProductResult {
  assertOfflineEligible(db);

  const productId = randomUUID();
  const createdAt = now();
  const installationId = getInstallationId(db);
  const actorUserId = getActorUserId(db);
  const sanitizedCodigos = sanitizeProductCodes(input.codigos);

  const run = db.transaction(() => {
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
      id: productId,
      detalle: input.detalle,
      costo_neto: input.costo_neto ?? null,
      costo_final: input.costo_final ?? null,
      iva: input.iva ?? null,
      cambio_costo: input.cambio_costo ?? "fixed",
      cambio_precio: input.cambio_precio ?? "fixed",
      etiqueta: input.etiqueta ?? "",
      facturable: input.facturable !== false ? 1 : 0,
      maneja_stock: input.maneja_stock !== false ? 1 : 0,
      codigos: JSON.stringify(sanitizedCodigos),
      pricing_mode: "fixed",
      created_at: createdAt,
    });

    insertProductOutbox(
      db, "product_create", productId,
      {
        id: productId,
        detalle: input.detalle,
        costo_neto: input.costo_neto ?? null,
        costo_final: input.costo_final ?? null,
        iva: input.iva ?? null,
        cambio_costo: input.cambio_costo ?? "fixed",
        cambio_precio: input.cambio_precio ?? "fixed",
        etiqueta: input.etiqueta ?? "",
        facturable: input.facturable !== false,
        maneja_stock: input.maneja_stock !== false,
        codigos: sanitizedCodigos,
      },
      createdAt, installationId, actorUserId,
      `Product create: ${input.detalle}`,
    );

    markOfflineWorkRequiresRevalidation(db);
  });

  run();

  const row = db.prepare("SELECT * FROM products WHERE id = ?").get(productId) as OfflineProductRow | undefined;
  if (!row) {
    return { success: false, error: "Product not found after creation" };
  }

  return { success: true, product: mapRow(row) };
}

/**
 * Update a product locally and enqueue an outbox entry in the same transaction.
 * Requires a cached offline session (auth guard).
 */
export function updateOfflineProduct(
  db: Database.Database,
  productId: string,
  input: OfflineProductUpdateInput,
): OfflineProductResult {
  assertOfflineEligible(db);

  const createdAt = now();
  const installationId = getInstallationId(db);
  const actorUserId = getActorUserId(db);
  const sanitizedCodigos = input.codigos !== undefined ? sanitizeProductCodes(input.codigos) : undefined;

  const existing = db.prepare("SELECT * FROM products WHERE id = ?").get(productId) as OfflineProductRow | undefined;
  if (!existing) {
    return { success: false, error: "Product not found" };
  }

  const run = db.transaction(() => {
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
      id: productId,
      detalle: input.detalle ?? null,
      costo_neto: input.costo_neto ?? null,
      costo_final: input.costo_final ?? null,
      iva: input.iva ?? null,
      cambio_costo: input.cambio_costo ?? null,
      cambio_precio: input.cambio_precio ?? null,
      etiqueta: input.etiqueta ?? null,
      facturable: input.facturable !== undefined ? (input.facturable ? 1 : 0) : null,
      maneja_stock: input.maneja_stock !== undefined ? (input.maneja_stock ? 1 : 0) : null,
      codigos: sanitizedCodigos !== undefined ? JSON.stringify(sanitizedCodigos) : null,
      updated_at: createdAt,
    });

    const payload: Record<string, unknown> = { id: productId };
    if (input.detalle !== undefined) payload.detalle = input.detalle;
    if (input.costo_neto !== undefined) payload.costo_neto = input.costo_neto;
    if (input.costo_final !== undefined) payload.costo_final = input.costo_final;
    if (input.iva !== undefined) payload.iva = input.iva;
    if (input.cambio_costo !== undefined) payload.cambio_costo = input.cambio_costo;
    if (input.cambio_precio !== undefined) payload.cambio_precio = input.cambio_precio;
    if (input.etiqueta !== undefined) payload.etiqueta = input.etiqueta;
    if (input.facturable !== undefined) payload.facturable = input.facturable;
    if (input.maneja_stock !== undefined) payload.maneja_stock = input.maneja_stock;
    if (sanitizedCodigos !== undefined) payload.codigos = sanitizedCodigos;

    insertProductOutbox(
      db, "product_update", productId, payload,
      createdAt, installationId, actorUserId,
      `Product update: ${productId.slice(0, 8)}`,
    );

    markOfflineWorkRequiresRevalidation(db);
  });

  run();

  const row = db.prepare("SELECT * FROM products WHERE id = ?").get(productId) as OfflineProductRow | undefined;
  if (!row) {
    return { success: false, error: "Product not found after update" };
  }

  return { success: true, product: mapRow(row) };
}

/**
 * Delete a product locally and enqueue an outbox entry in the same transaction.
 *
 * - Requires a cached offline session (auth guard).
 * - Rejects protected products (`is_protected = 1`) with `ProtectedProductError`.
 * - Records a `before` snapshot in the outbox payload for restore on rejection.
 */
export function deleteOfflineProduct(
  db: Database.Database,
  productId: string,
): OfflineProductResult {
  assertOfflineEligible(db);

  const createdAt = now();
  const installationId = getInstallationId(db);
  const actorUserId = getActorUserId(db);

  const existing = db.prepare("SELECT * FROM products WHERE id = ?").get(productId) as OfflineProductRow | undefined;
  if (!existing) {
    return { success: false, error: "Product not found" };
  }

  // Protected delete guard
  if (existing.is_protected === 1) {
    return { success: false, error: "Cannot delete a protected product", errorCode: "PROTECTED_PRODUCT" };
  }

  // Snapshot for recovery on rejection
  const beforeSnapshot = mapRow(existing)!;

  const run = db.transaction(() => {
    db.prepare("DELETE FROM products WHERE id = ?").run(productId);

    insertProductOutbox(
      db, "product_delete", productId,
      {
        id: productId,
        before: beforeSnapshot,
      },
      createdAt, installationId, actorUserId,
      `Product delete: ${beforeSnapshot.detalle}`,
    );

    markOfflineWorkRequiresRevalidation(db);
  });

  run();

  return { success: true };
}

/**
 * List all products from the local store.
 */
export function listOfflineProducts(db: Database.Database): OfflineProductResult[] {
  const rows = db.prepare("SELECT * FROM products ORDER BY detalle ASC").all() as OfflineProductRow[];
  return rows.map((row) => ({ success: true, product: mapRow(row) }));
}

/**
 * Search products with optional filter support.
 */
export function searchOfflineProducts(
  db: Database.Database,
  filters?: { search?: string },
): OfflineProductResult[] {
  const search = filters?.search?.trim();

  if (!search) {
    return listOfflineProducts(db);
  }

  const likePattern = `%${search}%`;

  const rows = db
    .prepare(
      `SELECT * FROM products
       WHERE LOWER(detalle) LIKE LOWER(?)
          OR LOWER(codigos) LIKE LOWER(?)
       ORDER BY detalle ASC`,
    )
    .all(likePattern, likePattern) as OfflineProductRow[];

  return rows.map((row) => ({ success: true, product: mapRow(row) }));
}

/**
 * Find a single product by an exact code (barcode/SKU) in the `codigos` JSON array.
 */
export function findOfflineProductByCode(
  db: Database.Database,
  code: string,
): OfflineProductResult {
  const trimmed = code.trim();
  if (!trimmed) {
    return { success: false, error: "Product not found by code" };
  }

  const likePattern = `%"${trimmed}"%`;

  const row = db
    .prepare(
      `SELECT * FROM products
       WHERE codigos LIKE ?
       LIMIT 1`,
    )
    .get(likePattern) as OfflineProductRow | undefined;

  if (!row) {
    return { success: false, error: "Product not found by code" };
  }

  return { success: true, product: mapRow(row) };
}

/**
 * Get a single product by ID.
 */
export function getOfflineProduct(db: Database.Database, productId: string): OfflineProductResult {
  const row = db.prepare("SELECT * FROM products WHERE id = ?").get(productId) as OfflineProductRow | undefined;
  if (!row) {
    return { success: false, error: "Product not found" };
  }
  return { success: true, product: mapRow(row) };
}
