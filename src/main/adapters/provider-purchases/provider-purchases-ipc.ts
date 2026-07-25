// ---------------------------------------------------------------------------
// Adapter: Provider Purchases IPC handlers
//
// Electron primary adapter. Owns PROVIDER_PURCHASES_CHANNELS, handler
// registration/unregistration, and legacy-compatible error mapping. Preserves
// the existing permissive casting behavior — no strict Products-style runtime
// validation or errorCode values are introduced. Calls ProviderPurchaseService;
// does NOT import better-sqlite3 or call getDb().
// ---------------------------------------------------------------------------

import { ipcMain } from "electron";
import { PROVIDER_PURCHASES_CHANNELS } from "../../../shared/ipc-channels";
import type { ProviderPurchaseService } from "../../application/provider-purchases/provider-purchase-service";
import type {
  OfflineProviderPurchaseInput,
  OfflineProviderPurchaseUpdateInput,
  OfflineProviderPurchaseResult,
} from "../../domain/provider-purchases/provider-purchase";
import type { BusyTracker } from "../../busy-state";

export { PROVIDER_PURCHASES_CHANNELS };

// Re-export for preload consumers
export type { OfflineProviderPurchaseInput, OfflineProviderPurchaseUpdateInput, OfflineProviderPurchaseResult };

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerProviderPurchasesIpc(
  providerPurchaseService: ProviderPurchaseService,
  busyTracker?: BusyTracker,
): void {
  ipcMain.handle(PROVIDER_PURCHASES_CHANNELS.CREATE, (_event, input: unknown) => {
    const run = async () => {
      try {
        return providerPurchaseService.createProviderPurchase(input as OfflineProviderPurchaseInput);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Failed to create purchase" };
      }
    };

    return busyTracker?.runProtectedOperation("write", "Create provider purchase", run) ?? run();
  });

  ipcMain.handle(PROVIDER_PURCHASES_CHANNELS.UPDATE, (_event, purchaseId: string, input: unknown) => {
    const run = async () => {
      try {
        return providerPurchaseService.updateProviderPurchase(purchaseId, input as OfflineProviderPurchaseUpdateInput);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Failed to update purchase" };
      }
    };

    return busyTracker?.runProtectedOperation("write", "Update provider purchase", run) ?? run();
  });

  ipcMain.handle(PROVIDER_PURCHASES_CHANNELS.LIST, (_event): OfflineProviderPurchaseResult[] => {
    try {
      return providerPurchaseService.listProviderPurchases();
    } catch (err) {
      return [{ success: false, error: err instanceof Error ? err.message : "Failed to list purchases" }];
    }
  });

  ipcMain.handle(PROVIDER_PURCHASES_CHANNELS.DELETE, (_event, purchaseId: string) => {
    const run = async () => {
      try {
        return providerPurchaseService.deleteProviderPurchase(purchaseId);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Failed to delete purchase" };
      }
    };

    return busyTracker?.runProtectedOperation("write", "Delete provider purchase", run) ?? run();
  });
}

export function unregisterProviderPurchasesIpc(): void {
  ipcMain.removeHandler(PROVIDER_PURCHASES_CHANNELS.CREATE);
  ipcMain.removeHandler(PROVIDER_PURCHASES_CHANNELS.UPDATE);
  ipcMain.removeHandler(PROVIDER_PURCHASES_CHANNELS.LIST);
  ipcMain.removeHandler(PROVIDER_PURCHASES_CHANNELS.DELETE);
}
