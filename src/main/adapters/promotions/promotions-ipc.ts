// ---------------------------------------------------------------------------
// Adapter: Promotions IPC handlers
//
// Electron primary adapter. Owns PROMOTIONS_CHANNELS, handler registration/
// unregistration, and legacy-compatible error mapping. Preserves the same
// permissive casting behavior as the legacy promotions-ipc.ts — no strict
// Products-style runtime validation or errorCode values are introduced.
// Calls PromotionService; does NOT import better-sqlite3 or call getDb().
// ---------------------------------------------------------------------------

import { ipcMain } from "electron";
import type { PromotionService } from "../../application/promotions/promotion-service";
import type {
  OfflinePromotionInput,
  OfflinePromotionUpdateInput,
  OfflinePromotionResult,
} from "../../domain/promotions/promotion";

// Re-export for preload consumers
export type { OfflinePromotionInput, OfflinePromotionUpdateInput, OfflinePromotionResult };

// ---------------------------------------------------------------------------
// IPC channel constants
// ---------------------------------------------------------------------------

export const PROMOTIONS_CHANNELS = {
  CREATE: "offline:promotions:create",
  UPDATE: "offline:promotions:update",
  DELETE: "offline:promotions:delete",
  LIST: "offline:promotions:list",
} as const;

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerPromotionsIpc(promotionService: PromotionService): void {
  ipcMain.handle(PROMOTIONS_CHANNELS.CREATE, (_event, input: unknown): OfflinePromotionResult => {
    try {
      return promotionService.createPromotion(input as OfflinePromotionInput);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Failed to create promotion" };
    }
  });

  ipcMain.handle(PROMOTIONS_CHANNELS.UPDATE, (_event, promotionId: string, input: unknown): OfflinePromotionResult => {
    try {
      return promotionService.updatePromotion(promotionId, input as OfflinePromotionUpdateInput);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Failed to update promotion" };
    }
  });

  ipcMain.handle(PROMOTIONS_CHANNELS.DELETE, (_event, promotionId: string): OfflinePromotionResult => {
    try {
      return promotionService.deletePromotion(promotionId);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Failed to delete promotion" };
    }
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
