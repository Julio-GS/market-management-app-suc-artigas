import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

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
// Operations
// ---------------------------------------------------------------------------

/**
 * Create a product locally and enqueue an outbox entry in the same transaction.
 */
export function createOfflineProduct(
  db: Database.Database,
  input: OfflineProductInput,
): OfflineProductResult {
  const productId = randomUUID();
  const createdAt = now();
  const installationId = getInstallationId(db);

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
      codigos: JSON.stringify(input.codigos ?? []),
      pricing_mode: "fixed",
      created_at: createdAt,
    });

    // Outbox entry
    const outboxId = randomUUID();
    const idempotencyKey = `${installationId}:${outboxId}`;

    const payload = JSON.stringify({
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
      codigos: input.codigos ?? [],
    });

    db.prepare(`
      INSERT INTO outbox
        (id, idempotency_key, operation_type, aggregate_type, aggregate_id,
         payload, status, attempt_count, created_at, updated_at)
      VALUES
        (@id, @idempotency_key, 'product_create', 'product', @aggregate_id,
         @payload, 'pending', 0, @created_at, @created_at)
    `).run({
      id: outboxId,
      idempotency_key: idempotencyKey,
      aggregate_id: productId,
      payload,
      created_at: createdAt,
    });
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
 */
export function updateOfflineProduct(
  db: Database.Database,
  productId: string,
  input: OfflineProductUpdateInput,
): OfflineProductResult {
  const createdAt = now();
  const installationId = getInstallationId(db);

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
      codigos: input.codigos ? JSON.stringify(input.codigos) : null,
      updated_at: createdAt,
    });

    // Outbox entry
    const outboxId = randomUUID();
    const idempotencyKey = `${installationId}:${outboxId}`;

    const payload = JSON.stringify({
      id: productId,
      ...(input.detalle !== undefined && { detalle: input.detalle }),
      ...(input.costo_neto !== undefined && { costo_neto: input.costo_neto }),
      ...(input.costo_final !== undefined && { costo_final: input.costo_final }),
      ...(input.iva !== undefined && { iva: input.iva }),
      ...(input.cambio_costo !== undefined && { cambio_costo: input.cambio_costo }),
      ...(input.cambio_precio !== undefined && { cambio_precio: input.cambio_precio }),
      ...(input.etiqueta !== undefined && { etiqueta: input.etiqueta }),
      ...(input.facturable !== undefined && { facturable: input.facturable }),
      ...(input.maneja_stock !== undefined && { maneja_stock: input.maneja_stock }),
      ...(input.codigos !== undefined && { codigos: input.codigos }),
    });

    db.prepare(`
      INSERT INTO outbox
        (id, idempotency_key, operation_type, aggregate_type, aggregate_id,
         payload, status, attempt_count, created_at, updated_at)
      VALUES
        (@id, @idempotency_key, 'product_update', 'product', @aggregate_id,
         @payload, 'pending', 0, @created_at, @created_at)
    `).run({
      id: outboxId,
      idempotency_key: idempotencyKey,
      aggregate_id: productId,
      payload,
      created_at: createdAt,
    });
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
 */
export function deleteOfflineProduct(
  db: Database.Database,
  productId: string,
): OfflineProductResult {
  const createdAt = now();
  const installationId = getInstallationId(db);

  const existing = db.prepare("SELECT * FROM products WHERE id = ?").get(productId) as OfflineProductRow | undefined;
  if (!existing) {
    return { success: false, error: "Product not found" };
  }

  const run = db.transaction(() => {
    db.prepare("DELETE FROM products WHERE id = ?").run(productId);

    // Outbox entry
    const outboxId = randomUUID();
    const idempotencyKey = `${installationId}:${outboxId}`;

    db.prepare(`
      INSERT INTO outbox
        (id, idempotency_key, operation_type, aggregate_type, aggregate_id,
         payload, status, attempt_count, created_at, updated_at)
      VALUES
        (@id, @idempotency_key, 'product_delete', 'product', @aggregate_id,
         '{}', 'pending', 0, @created_at, @created_at)
    `).run({
      id: outboxId,
      idempotency_key: idempotencyKey,
      aggregate_id: productId,
      created_at: createdAt,
    });
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
 *
 * - When no filter is provided, returns all products (same as listOfflineProducts).
 * - When `search` is provided, filters products where `detalle` matches
 *   case-insensitive substring OR any entry in the `codigos` JSON array matches.
 *
 * This is the primary path for POS/sales product lookup offline.
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
 *
 * Used by POS barcode scan path and `findByCode` repository lookups.
 */
export function findOfflineProductByCode(
  db: Database.Database,
  code: string,
): OfflineProductResult {
  const trimmed = code.trim();
  if (!trimmed) {
    return { success: false, error: "Product not found by code" };
  }

  // The codigos column stores a JSON array like ["LEC-0001","77912340001"].
  // We search for the exact code string within that JSON.
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
