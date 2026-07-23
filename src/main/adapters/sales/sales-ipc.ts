// ---------------------------------------------------------------------------
// Adapter: Sales IPC handlers
//
// Owns channel constants, lightweight payload validation, Electron
// registration/unregistration, result mapping, and legacy error codes.
// Delegates all persistence work to SaleService.
// ---------------------------------------------------------------------------

import { ipcMain } from "electron";
import { FiscalBlockedError } from "../../domain/sales/sale";
import { OfflineAuthRequiredError } from "../../offline-auth";
import { type SaleService } from "../../application/sales/sale-service";

// Re-export for preload consumers
export type { OfflineSaleInput, ListedSale } from "../../domain/sales/sale";

// ---------------------------------------------------------------------------
// Minimal runtime payload validation
// ---------------------------------------------------------------------------

/**
 * Validate the IPC payload shape before passing it to the local sale
 * transaction. This is a lightweight schema guard, not exhaustive business
 * validation — that lives in the repository.
 */
export function validateSaleInput(
  input: unknown,
): { valid: true; data: import("../../domain/sales/sale").OfflineSaleInput } | { valid: false; error: string } {
  if (!input || typeof input !== "object") {
    return { valid: false, error: "Sale input must be an object" };
  }

  const data = input as Record<string, unknown>;

  if (!Array.isArray(data.items) || data.items.length === 0) {
    return { valid: false, error: "Sale input must contain at least one item" };
  }

  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i] as Record<string, unknown> | undefined;
    if (
      !item ||
      typeof item.productId !== "string" ||
      item.productId.trim().length === 0
    ) {
      return { valid: false, error: `Item ${i + 1} must have a valid productId` };
    }
    if (typeof item.quantity !== "number" || item.quantity <= 0) {
      return { valid: false, error: `Item ${i + 1} must have a positive quantity` };
    }
  }

  if (!Array.isArray(data.payments) || data.payments.length === 0) {
    return { valid: false, error: "Sale input must contain at least one payment" };
  }

  for (let i = 0; i < data.payments.length; i++) {
    const pm = data.payments[i] as Record<string, unknown> | undefined;
    if (!pm || typeof pm.method !== "string" || pm.method.length === 0) {
      return { valid: false, error: `Payment ${i + 1} must have a valid method` };
    }
    if (typeof pm.amount !== "string") {
      return { valid: false, error: `Payment ${i + 1} must have an amount string` };
    }
  }

  if (typeof data.total !== "string") {
    return { valid: false, error: "Sale input must have a total string" };
  }

  if (typeof data.invoiceRequested !== "boolean") {
    return { valid: false, error: "Sale input must specify invoiceRequested as boolean" };
  }

  return {
    valid: true,
    data: input as import("../../domain/sales/sale").OfflineSaleInput,
  };
}

// ---------------------------------------------------------------------------
// IPC channel constants
// ---------------------------------------------------------------------------

export const SALES_CHANNELS = {
  COMPLETE_SALE: "offline:sales:complete",
  GET_SALE: "offline:sales:get",
  LIST_SALES: "offline:sales:list",
} as const;

// ---------------------------------------------------------------------------
// Result types exposed to the renderer
// ---------------------------------------------------------------------------

export interface OfflineSaleIpcResult {
  success: boolean;
  sale?: {
    id: string;
    total: string;
    customer: string;
    invoiceStatus: string;
    createdAt: string;
  };
  warnings?: string[];
  error?: string;
  errorCode?: string;
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register all sales-related IPC handlers.
 */
export function registerSalesIpc(saleService: SaleService): void {
  ipcMain.handle(
    SALES_CHANNELS.COMPLETE_SALE,
    (_event, input: unknown): OfflineSaleIpcResult => {
      // Validate IPC payload before touching the database
      const validated = validateSaleInput(input);
      if (!validated.valid) {
        return { success: false, error: validated.error, errorCode: "INVALID_INPUT" };
      }

      try {
        const result = saleService.completeSale(validated.data);

        return {
          success: true,
          sale: result.sale,
          warnings: result.warnings,
        };
      } catch (err) {
        if (err instanceof FiscalBlockedError) {
          return {
            success: false,
            error: err.message,
            errorCode: "FISCAL_BLOCKED",
          };
        }
        if (err instanceof OfflineAuthRequiredError) {
          return {
            success: false,
            error: err.message,
            errorCode: "OFFLINE_AUTH_REQUIRED",
          };
        }
        const message = err instanceof Error ? err.message : "Sale failed";
        return {
          success: false,
          error: message,
          errorCode: "SALE_ERROR",
        };
      }
    },
  );

  ipcMain.handle(
    SALES_CHANNELS.GET_SALE,
    (_event, saleId: string): OfflineSaleIpcResult => {
      try {
        const sale = saleService.getSale(saleId);

        if (!sale) {
          return { success: false, error: "Sale not found", errorCode: "NOT_FOUND" };
        }

        return {
          success: true,
          sale: {
            id: sale.id,
            total: sale.total,
            customer: sale.customer,
            invoiceStatus: sale.invoiceStatus,
            createdAt: sale.createdAt,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to retrieve sale";
        return { success: false, error: message, errorCode: "SALE_ERROR" };
      }
    },
  );

  // -- sales:list ----------------------------------------------------------
  ipcMain.handle(
    SALES_CHANNELS.LIST_SALES,
    (): import("../../domain/sales/sale").ListedSale[] => {
      try {
        return saleService.listSales();
      } catch {
        return [];
      }
    },
  );
}

/**
 * Remove all sales IPC handlers.
 */
export function unregisterSalesIpc(): void {
  ipcMain.removeHandler(SALES_CHANNELS.COMPLETE_SALE);
  ipcMain.removeHandler(SALES_CHANNELS.GET_SALE);
  ipcMain.removeHandler(SALES_CHANNELS.LIST_SALES);
}
