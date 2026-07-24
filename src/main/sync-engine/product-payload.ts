// ---------------------------------------------------------------------------
// Product payload apply / restore helpers
//
// Extracted from src/main/sync-engine.ts — logic preserved verbatim.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";

/**
 * Apply a server-won product payload to the local products table.
 *
 * Only updates fields present in the payload; leaves other columns unchanged.
 * Upserts the row so products that don't exist locally yet are created.
 */
export function applyServerProductPayload(
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

/**
 * Restore a product that was locally deleted but whose delete operation was
 * definitively rejected by the server. Re-inserts the product row from the
 * `before` snapshot stored in the outbox payload.
 */
export function restoreProductFromSnapshot(
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
