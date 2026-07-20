import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import {
  createOfflineProduct,
  updateOfflineProduct,
  deleteOfflineProduct,
  listOfflineProducts,
  searchOfflineProducts,
  findOfflineProductByCode,
  getOfflineProduct,
  type OfflineProductInput,
  type OfflineProductUpdateInput,
  type OfflineProductResult,
} from "./products-local";

// Re-export for preload consumers
export type { OfflineProductInput, OfflineProductUpdateInput, OfflineProductResult };

// ---------------------------------------------------------------------------
// Minimal runtime payload validation
// ---------------------------------------------------------------------------

function validateProductInput(
  input: unknown,
): { valid: true; data: OfflineProductInput } | { valid: false; error: string } {
  if (!input || typeof input !== "object") {
    return { valid: false, error: "Product input must be an object" };
  }

  const data = input as Record<string, unknown>;

  if (typeof data.detalle !== "string" || data.detalle.trim().length === 0) {
    return { valid: false, error: "Product input must have a non-empty detalle" };
  }

  return {
    valid: true,
    data: input as OfflineProductInput,
  };
}

// ---------------------------------------------------------------------------
// IPC channel constants
// ---------------------------------------------------------------------------

export const PRODUCTS_CHANNELS = {
  CREATE: "offline:products:create",
  UPDATE: "offline:products:update",
  DELETE: "offline:products:delete",
  LIST: "offline:products:list",
  GET: "offline:products:get",
  FIND_BY_CODE: "offline:products:findByCode",
} as const;

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerProductsIpc(getDb: () => Database.Database): void {
  ipcMain.handle(
    PRODUCTS_CHANNELS.CREATE,
    (_event, input: unknown): OfflineProductResult => {
      const validated = validateProductInput(input);
      if (!validated.valid) {
        return { success: false, error: validated.error };
      }

      try {
        const db = getDb();
        return createOfflineProduct(db, validated.data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to create product";
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    PRODUCTS_CHANNELS.UPDATE,
    (_event, productId: string, input: unknown): OfflineProductResult => {
      try {
        const db = getDb();
        return updateOfflineProduct(db, productId, input as OfflineProductUpdateInput);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to update product";
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    PRODUCTS_CHANNELS.DELETE,
    (_event, productId: string): OfflineProductResult => {
      try {
        const db = getDb();
        return deleteOfflineProduct(db, productId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to delete product";
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    PRODUCTS_CHANNELS.LIST,
    (_event, filters?: { search?: string }): OfflineProductResult[] => {
      try {
        const db = getDb();
        return searchOfflineProducts(db, filters);
      } catch (err) {
        return [{ success: false, error: err instanceof Error ? err.message : "Failed to list products" }];
      }
    },
  );

  ipcMain.handle(
    PRODUCTS_CHANNELS.FIND_BY_CODE,
    (_event, code: string): OfflineProductResult => {
      try {
        const db = getDb();
        return findOfflineProductByCode(db, code);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to find product by code";
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    PRODUCTS_CHANNELS.GET,
    (_event, productId: string): OfflineProductResult => {
      try {
        const db = getDb();
        return getOfflineProduct(db, productId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to get product";
        return { success: false, error: message };
      }
    },
  );
}

export function unregisterProductsIpc(): void {
  ipcMain.removeHandler(PRODUCTS_CHANNELS.CREATE);
  ipcMain.removeHandler(PRODUCTS_CHANNELS.UPDATE);
  ipcMain.removeHandler(PRODUCTS_CHANNELS.DELETE);
  ipcMain.removeHandler(PRODUCTS_CHANNELS.LIST);
  ipcMain.removeHandler(PRODUCTS_CHANNELS.GET);
  ipcMain.removeHandler(PRODUCTS_CHANNELS.FIND_BY_CODE);
}
