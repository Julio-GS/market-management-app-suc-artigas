// ---------------------------------------------------------------------------
// Infrastructure: Products SQLite repository
//
// Implements IProductsRepository using better-sqlite3. Preserves all existing
// SQL, row mapping, transaction boundaries, outbox semantics, auth guards, and
// revalidation behavior from the previous Products persistence implementation.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  assertOfflineEligible,
  getActorUserId,
  markOfflineWorkRequiresRevalidation,
} from "../../offline-auth";
import type { IProductsRepository } from "../../domain/products/products-repository";
import type {
  OfflineProductInput,
  OfflineProductResult,
  OfflineProductUpdateInput,
  ProductSearchFilters,
} from "../../domain/products/product";
import { sanitizeProductCodes } from "../../domain/products/product";
import type { IOutboxRepository } from "../../ports/outbox-repository";

// ---------------------------------------------------------------------------
// Internal row shape (database representation — NOT exported)
// ---------------------------------------------------------------------------

interface OfflineProductRow {
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
// Repository
// ---------------------------------------------------------------------------

export class ProductsSqliteRepository implements IProductsRepository {
  constructor(
    private readonly getDb: () => Database.Database,
    private readonly outboxRepository: IOutboxRepository,
  ) {}

  create(input: OfflineProductInput): OfflineProductResult {
    const db = this.getDb();
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

      this.outboxRepository.enqueue({
        operationType: "product_create",
        aggregateType: "product",
        aggregateId: productId,
        payload: {
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
        createdAt,
        installationId,
        actorUserId,
        entityLabel: `Product create: ${input.detalle}`,
      });

      markOfflineWorkRequiresRevalidation(db);
    });

    run();

    const row = db.prepare("SELECT * FROM products WHERE id = ?").get(productId) as OfflineProductRow | undefined;
    if (!row) {
      return { success: false, error: "Product not found after creation" };
    }

    return { success: true, product: mapRow(row) };
  }

  update(productId: string, input: OfflineProductUpdateInput): OfflineProductResult {
    const db = this.getDb();
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

      this.outboxRepository.enqueue({
        operationType: "product_update",
        aggregateType: "product",
        aggregateId: productId,
        payload,
        createdAt,
        installationId,
        actorUserId,
        entityLabel: `Product update: ${productId.slice(0, 8)}`,
      });

      markOfflineWorkRequiresRevalidation(db);
    });

    run();

    const row = db.prepare("SELECT * FROM products WHERE id = ?").get(productId) as OfflineProductRow | undefined;
    if (!row) {
      return { success: false, error: "Product not found after update" };
    }

    return { success: true, product: mapRow(row) };
  }

  delete(productId: string): OfflineProductResult {
    const db = this.getDb();
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

      this.outboxRepository.enqueue({
        operationType: "product_delete",
        aggregateType: "product",
        aggregateId: productId,
        payload: {
          id: productId,
          before: beforeSnapshot,
        },
        createdAt,
        installationId,
        actorUserId,
        entityLabel: `Product delete: ${beforeSnapshot.detalle}`,
      });

      markOfflineWorkRequiresRevalidation(db);
    });

    run();

    return { success: true };
  }

  list(): OfflineProductResult[] {
    const db = this.getDb();
    const rows = db.prepare("SELECT * FROM products ORDER BY detalle ASC").all() as OfflineProductRow[];
    return rows.map((row) => ({ success: true, product: mapRow(row) }));
  }

  search(filters?: ProductSearchFilters): OfflineProductResult[] {
    const db = this.getDb();
    const search = filters?.search?.trim();

    if (!search) {
      return this.list();
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

  findByCode(code: string): OfflineProductResult {
    const db = this.getDb();
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

  get(productId: string): OfflineProductResult {
    const db = this.getDb();
    const row = db.prepare("SELECT * FROM products WHERE id = ?").get(productId) as OfflineProductRow | undefined;
    if (!row) {
      return { success: false, error: "Product not found" };
    }
    return { success: true, product: mapRow(row) };
  }
}
