// ---------------------------------------------------------------------------
// Provider purchase payload apply / restore helpers
//
// Extracted from src/main/sync-engine.ts — logic preserved verbatim.
// ---------------------------------------------------------------------------

import type Database from "better-sqlite3";

/**
 * Apply a server-won provider purchase payload to the local table.
 */
export function applyServerProviderPurchasePayload(
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
export function restoreProviderPurchaseFromSnapshot(
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
