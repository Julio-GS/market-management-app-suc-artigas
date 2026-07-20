import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import {
  createOfflinePromotion,
  updateOfflinePromotion,
  deleteOfflinePromotion,
  listOfflinePromotions,
  type OfflinePromotionInput,
  type OfflinePromotionUpdateInput,
  type OfflinePromotionResult,
} from "./promotions-local";

export type { OfflinePromotionInput, OfflinePromotionUpdateInput, OfflinePromotionResult };

export const PROMOTIONS_CHANNELS = {
  CREATE: "offline:promotions:create",
  UPDATE: "offline:promotions:update",
  DELETE: "offline:promotions:delete",
  LIST: "offline:promotions:list",
} as const;

export function registerPromotionsIpc(getDb: () => Database.Database): void {
  ipcMain.handle(PROMOTIONS_CHANNELS.CREATE, (_event, input: unknown): OfflinePromotionResult => {
    try {
      return createOfflinePromotion(getDb(), input as OfflinePromotionInput);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Failed to create promotion" };
    }
  });

  ipcMain.handle(PROMOTIONS_CHANNELS.UPDATE, (_event, promoId: string, input: unknown): OfflinePromotionResult => {
    try {
      return updateOfflinePromotion(getDb(), promoId, input as OfflinePromotionUpdateInput);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Failed to update promotion" };
    }
  });

  ipcMain.handle(PROMOTIONS_CHANNELS.DELETE, (_event, promoId: string): OfflinePromotionResult => {
    try {
      return deleteOfflinePromotion(getDb(), promoId);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Failed to delete promotion" };
    }
  });

  ipcMain.handle(PROMOTIONS_CHANNELS.LIST, (_event): OfflinePromotionResult[] => {
    try {
      return listOfflinePromotions(getDb());
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
