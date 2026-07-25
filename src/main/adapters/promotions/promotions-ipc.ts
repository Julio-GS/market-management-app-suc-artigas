// ---------------------------------------------------------------------------
// Adapter: Promotions IPC handlers
//
// Electron primary adapter. Owns PROMOTIONS_CHANNELS, handler registration/
// unregistration, and legacy-compatible error mapping. Preserves the existing
// permissive casting behavior — no strict Products-style runtime validation or
// errorCode values are introduced.
// Calls PromotionService; does NOT import better-sqlite3 or call getDb().
// ---------------------------------------------------------------------------

import { ipcMain } from "electron";
import { PROMOTIONS_CHANNELS } from "../../../shared/ipc-channels";
import type { PromotionService } from "../../application/promotions/promotion-service";
import type { BusyTracker } from "../../busy-state";
import type {
  OfflinePromotionInput,
  OfflinePromotionUpdateInput,
  OfflinePromotionResult,
} from "../../domain/promotions/promotion";

export { PROMOTIONS_CHANNELS };

// Re-export for preload consumers
export type { OfflinePromotionInput, OfflinePromotionUpdateInput, OfflinePromotionResult };

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerPromotionsIpc(
  promotionService: PromotionService,
  busyTracker?: BusyTracker,
): void {
  ipcMain.handle(PROMOTIONS_CHANNELS.CREATE, (_event, input: unknown): Promise<OfflinePromotionResult> | OfflinePromotionResult => {
    const run = async () => {
      try {
        return promotionService.createPromotion(input as OfflinePromotionInput);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Failed to create promotion" };
      }
    };

    return busyTracker?.runProtectedOperation("write", "Create promotion", run) ?? run();
  });

  ipcMain.handle(PROMOTIONS_CHANNELS.UPDATE, (_event, promotionId: string, input: unknown): Promise<OfflinePromotionResult> | OfflinePromotionResult => {
    const run = async () => {
      try {
        return promotionService.updatePromotion(promotionId, input as OfflinePromotionUpdateInput);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Failed to update promotion" };
      }
    };

    return busyTracker?.runProtectedOperation("write", "Update promotion", run) ?? run();
  });

  ipcMain.handle(PROMOTIONS_CHANNELS.DELETE, (_event, promotionId: string): Promise<OfflinePromotionResult> | OfflinePromotionResult => {
    const run = async () => {
      try {
        return promotionService.deletePromotion(promotionId);
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Failed to delete promotion" };
      }
    };

    return busyTracker?.runProtectedOperation("write", "Delete promotion", run) ?? run();
  });

  ipcMain.handle(PROMOTIONS_CHANNELS.LIST, (_event): OfflinePromotionResult[] => {
    try {
      return promotionService.listPromotions();
    } catch (err) {
      return [{ success: false, error: err instanceof Error ? err.message : "Failed to list promotions" }];
    }
  });
}

export function unregisterPromotionsIpc(): void {
  ipcMain.removeHandler(PROMOTIONS_CHANNELS.CREATE);
  ipcMain.removeHandler(PROMOTIONS_CHANNELS.UPDATE);
  ipcMain.removeHandler(PROMOTIONS_CHANNELS.DELETE);
  ipcMain.removeHandler(PROMOTIONS_CHANNELS.LIST);
}
