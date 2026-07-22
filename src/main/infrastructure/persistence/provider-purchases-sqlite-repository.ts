// ---------------------------------------------------------------------------
// Infrastructure: Provider Purchases SQLite repository
//
// Implements IProviderPurchasesRepository using better-sqlite3. Preserves all
// existing SQL, row mapping, transaction boundaries, outbox semantics, auth
// guards, and revalidation behavior from the original provider-purchases-local.ts.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  assertOfflineEligible,
  getActorUserId,
  markOfflineWorkRequiresRevalidation,
} from "../../offline-auth";
import type { IProviderPurchasesRepository } from "../../domain/provider-purchases/provider-purchases-repository";
import type {
  OfflineProviderPurchaseInput,
  OfflineProviderPurchaseResult,
  OfflineProviderPurchaseUpdateInput,
  OfflineProviderPurchaseRow,
  ProviderPurchase,
} from "../../domain/provider-purchases/provider-purchase";
import type { IOutboxRepository } from "../../ports/outbox-repository";

// Re-export for IPC error mapping
export { OfflineAuthRequiredError } from "../../offline-auth";

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

function mapRow(row: OfflineProviderPurchaseRow): ProviderPurchase {
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
// Repository
// ---------------------------------------------------------------------------

export class ProviderPurchasesSqliteRepository implements IProviderPurchasesRepository {
  constructor(
    private readonly getDb: () => Database.Database,
    private readonly outboxRepository: IOutboxRepository,
  ) {}

  create(input: OfflineProviderPurchaseInput): OfflineProviderPurchaseResult {
    const db = this.getDb();
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

      this.outboxRepository.enqueue({
        operationType: "provider_purchase_create",
        aggregateType: "provider_purchase",
        aggregateId: purchaseId,
        payload: {
          id: purchaseId,
          provider_name: input.provider_name,
          amount: input.amount,
          payment_method: input.payment_method ?? null,
        },
        createdAt,
        installationId,
        actorUserId,
        entityLabel: `Provider purchase create: ${input.provider_name}`,
      });

      markOfflineWorkRequiresRevalidation(db);
    });

    run();

    const row = db.prepare("SELECT * FROM provider_purchases WHERE id = ?").get(purchaseId) as OfflineProviderPurchaseRow | undefined;
    if (!row) {
      return { success: false, error: "Purchase not found after creation" };
    }

    return { success: true, purchase: mapRow(row) };
  }

  update(
    purchaseId: string,
    input: OfflineProviderPurchaseUpdateInput,
  ): OfflineProviderPurchaseResult {
    const db = this.getDb();
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

      this.outboxRepository.enqueue({
        operationType: "provider_purchase_update",
        aggregateType: "provider_purchase",
        aggregateId: purchaseId,
        payload,
        createdAt,
        installationId,
        actorUserId,
        entityLabel: `Provider purchase update: ${purchaseId.slice(0, 8)}`,
      });

      markOfflineWorkRequiresRevalidation(db);
    });

    run();

    const row = db.prepare("SELECT * FROM provider_purchases WHERE id = ?").get(purchaseId) as OfflineProviderPurchaseRow | undefined;
    if (!row) {
      return { success: false, error: "Purchase not found after update" };
    }

    return { success: true, purchase: mapRow(row) };
  }

  delete(purchaseId: string): OfflineProviderPurchaseResult {
    const db = this.getDb();
    assertOfflineEligible(db);

    const createdAt = now();
    const installationId = getInstallationId(db);
    const actorUserId = getActorUserId(db);

    const existing = db.prepare("SELECT * FROM provider_purchases WHERE id = ?").get(purchaseId) as OfflineProviderPurchaseRow | undefined;
    if (!existing) {
      return { success: false, error: "Provider purchase not found" };
    }

    // Snapshot for recovery on rejection
    const beforeSnapshot = mapRow(existing);

    const run = db.transaction(() => {
      db.prepare("DELETE FROM provider_purchases WHERE id = ?").run(purchaseId);

      this.outboxRepository.enqueue({
        operationType: "provider_purchase_delete",
        aggregateType: "provider_purchase",
        aggregateId: purchaseId,
        payload: {
          id: purchaseId,
          before: beforeSnapshot,
        },
        createdAt,
        installationId,
        actorUserId,
        entityLabel: `Provider purchase delete: ${beforeSnapshot.providerName}`,
      });

      markOfflineWorkRequiresRevalidation(db);
    });

    run();

    return { success: true };
  }

  list(): OfflineProviderPurchaseResult[] {
    const db = this.getDb();
    const rows = db.prepare("SELECT * FROM provider_purchases ORDER BY created_at DESC").all() as OfflineProviderPurchaseRow[];
    return rows.map((row) => ({ success: true, purchase: mapRow(row) }));
  }
}
