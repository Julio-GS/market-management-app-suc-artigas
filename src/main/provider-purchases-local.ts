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

export interface OfflineProviderPurchaseInput {
  provider_name: string;
  amount: string;
  payment_method?: string;
}

export interface OfflineProviderPurchaseUpdateInput {
  provider_name?: string;
  amount?: string;
  payment_method?: string | null;
}

export interface OfflineProviderPurchaseRow {
  id: string;
  provider_name: string;
  amount: string;
  payment_method: string | null;
  created_at: string;
  updated_at: string;
}

export interface OfflineProviderPurchaseResult {
  success: boolean;
  purchase?: {
    id: string;
    providerName: string;
    amount: string;
    paymentMethod: string | null;
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

function mapRow(row: OfflineProviderPurchaseRow): OfflineProviderPurchaseResult["purchase"] {
  return {
    id: row.id,
    providerName: row.provider_name,
    amount: row.amount,
    paymentMethod: row.payment_method,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Outbox insert helper (shared across create/update/delete)
// ---------------------------------------------------------------------------

function insertProviderPurchaseOutbox(
  db: Database.Database,
  opType: string,
  purchaseId: string,
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
      (@id, @idempotency_key, @operation_type, 'provider_purchase', @aggregate_id,
       @payload, 'pending', 0, @created_at, @created_at,
       @local_device_timestamp, @actor_user_id, @entity_label)
  `).run({
    id: outboxId,
    idempotency_key: idempotencyKey,
    operation_type: opType,
    aggregate_id: purchaseId,
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

export function createOfflineProviderPurchase(
  db: Database.Database,
  input: OfflineProviderPurchaseInput,
): OfflineProviderPurchaseResult {
  assertOfflineEligible(db);

  const purchaseId = randomUUID();
  const createdAt = now();
  const installationId = getInstallationId(db);
  const actorUserId = getActorUserId(db);

  const run = db.transaction(() => {
    db.prepare(`
      INSERT INTO provider_purchases
        (id, provider_name, amount, payment_method, created_at, updated_at)
      VALUES
        (@id, @provider_name, @amount, @payment_method, @created_at, @created_at)
    `).run({
      id: purchaseId,
      provider_name: input.provider_name,
      amount: input.amount,
      payment_method: input.payment_method ?? null,
      created_at: createdAt,
    });

    insertProviderPurchaseOutbox(
      db, "provider_purchase_create", purchaseId,
      {
        id: purchaseId,
        provider_name: input.provider_name,
        amount: input.amount,
        payment_method: input.payment_method ?? null,
      },
      createdAt, installationId, actorUserId,
      `Provider purchase create: ${input.provider_name}`,
    );

    markOfflineWorkRequiresRevalidation(db);
  });

  run();

  const row = db.prepare("SELECT * FROM provider_purchases WHERE id = ?").get(purchaseId) as OfflineProviderPurchaseRow | undefined;
  if (!row) {
    return { success: false, error: "Purchase not found after creation" };
  }

  return { success: true, purchase: mapRow(row) };
}

export function updateOfflineProviderPurchase(
  db: Database.Database,
  purchaseId: string,
  input: OfflineProviderPurchaseUpdateInput,
): OfflineProviderPurchaseResult {
  assertOfflineEligible(db);

  const createdAt = now();
  const installationId = getInstallationId(db);
  const actorUserId = getActorUserId(db);

  const existing = db.prepare("SELECT * FROM provider_purchases WHERE id = ?").get(purchaseId) as OfflineProviderPurchaseRow | undefined;
  if (!existing) {
    return { success: false, error: "Provider purchase not found" };
  }

  const run = db.transaction(() => {
    db.prepare(`
      UPDATE provider_purchases SET
        provider_name = COALESCE(@provider_name, provider_name),
        amount = COALESCE(@amount, amount),
        payment_method = COALESCE(@payment_method, payment_method),
        updated_at = @updated_at
      WHERE id = @id
    `).run({
      id: purchaseId,
      provider_name: input.provider_name ?? null,
      amount: input.amount ?? null,
      payment_method: input.payment_method !== undefined ? input.payment_method : null,
      updated_at: createdAt,
    });

    const payload: Record<string, unknown> = { id: purchaseId };
    if (input.provider_name !== undefined) payload.provider_name = input.provider_name;
    if (input.amount !== undefined) payload.amount = input.amount;
    if (input.payment_method !== undefined) payload.payment_method = input.payment_method;

    insertProviderPurchaseOutbox(
      db, "provider_purchase_update", purchaseId, payload,
      createdAt, installationId, actorUserId,
      `Provider purchase update: ${purchaseId.slice(0, 8)}`,
    );

    markOfflineWorkRequiresRevalidation(db);
  });

  run();

  const row = db.prepare("SELECT * FROM provider_purchases WHERE id = ?").get(purchaseId) as OfflineProviderPurchaseRow | undefined;
  if (!row) {
    return { success: false, error: "Purchase not found after update" };
  }

  return { success: true, purchase: mapRow(row) };
}

export function listOfflineProviderPurchases(db: Database.Database): OfflineProviderPurchaseResult[] {
  const rows = db.prepare("SELECT * FROM provider_purchases ORDER BY created_at DESC").all() as OfflineProviderPurchaseRow[];
  return rows.map((row) => ({ success: true, purchase: mapRow(row) }));
}

export function deleteOfflineProviderPurchase(
  db: Database.Database,
  purchaseId: string,
): OfflineProviderPurchaseResult {
  assertOfflineEligible(db);

  const createdAt = now();
  const installationId = getInstallationId(db);
  const actorUserId = getActorUserId(db);

  const existing = db.prepare("SELECT * FROM provider_purchases WHERE id = ?").get(purchaseId) as OfflineProviderPurchaseRow | undefined;
  if (!existing) {
    return { success: false, error: "Provider purchase not found" };
  }

  // Snapshot for recovery on rejection
  const beforeSnapshot = mapRow(existing)!;

  const run = db.transaction(() => {
    db.prepare("DELETE FROM provider_purchases WHERE id = ?").run(purchaseId);

    insertProviderPurchaseOutbox(
      db, "provider_purchase_delete", purchaseId,
      {
        id: purchaseId,
        before: beforeSnapshot,
      },
      createdAt, installationId, actorUserId,
      `Provider purchase delete: ${beforeSnapshot.providerName}`,
    );

    markOfflineWorkRequiresRevalidation(db);
  });

  run();

  return { success: true };
}
