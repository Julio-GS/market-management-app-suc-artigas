import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import {
  createOfflineProviderPurchase,
  updateOfflineProviderPurchase,
  listOfflineProviderPurchases,
  deleteOfflineProviderPurchase,
  type OfflineProviderPurchaseInput,
  type OfflineProviderPurchaseUpdateInput,
  type OfflineProviderPurchaseResult,
} from "./provider-purchases-local";

export type { OfflineProviderPurchaseInput, OfflineProviderPurchaseUpdateInput, OfflineProviderPurchaseResult };

export const PROVIDER_PURCHASES_CHANNELS = {
  CREATE: "offline:provider-purchases:create",
  UPDATE: "offline:provider-purchases:update",
  LIST: "offline:provider-purchases:list",
  DELETE: "offline:provider-purchases:delete",
} as const;

export function registerProviderPurchasesIpc(getDb: () => Database.Database): void {
  ipcMain.handle(PROVIDER_PURCHASES_CHANNELS.CREATE, (_event, input: unknown): OfflineProviderPurchaseResult => {
    try {
      return createOfflineProviderPurchase(getDb(), input as OfflineProviderPurchaseInput);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Failed to create purchase" };
    }
  });

  ipcMain.handle(PROVIDER_PURCHASES_CHANNELS.UPDATE, (_event, purchaseId: string, input: unknown): OfflineProviderPurchaseResult => {
    try {
      return updateOfflineProviderPurchase(getDb(), purchaseId, input as OfflineProviderPurchaseUpdateInput);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Failed to update purchase" };
    }
  });

  ipcMain.handle(PROVIDER_PURCHASES_CHANNELS.LIST, (_event): OfflineProviderPurchaseResult[] => {
    try {
      return listOfflineProviderPurchases(getDb());
    } catch (err) {
      return [{ success: false, error: err instanceof Error ? err.message : "Failed to list purchases" }];
    }
  });

  ipcMain.handle(PROVIDER_PURCHASES_CHANNELS.DELETE, (_event, purchaseId: string): OfflineProviderPurchaseResult => {
    try {
      return deleteOfflineProviderPurchase(getDb(), purchaseId);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Failed to delete purchase" };
    }
  });
}

export function unregisterProviderPurchasesIpc(): void {
  ipcMain.removeHandler(PROVIDER_PURCHASES_CHANNELS.CREATE);
  ipcMain.removeHandler(PROVIDER_PURCHASES_CHANNELS.UPDATE);
  ipcMain.removeHandler(PROVIDER_PURCHASES_CHANNELS.LIST);
  ipcMain.removeHandler(PROVIDER_PURCHASES_CHANNELS.DELETE);
}
