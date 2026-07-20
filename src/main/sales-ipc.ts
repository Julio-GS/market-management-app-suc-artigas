import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import {
  completeOfflineSale,
  FiscalBlockedError,
  type OfflineSaleInput,
  type OfflineSaleResult,
} from "./sales-local";

// Re-export for preload consumers
export type { OfflineSaleInput };

// ---------------------------------------------------------------------------
// Minimal runtime payload validation
// ---------------------------------------------------------------------------

/**
 * Validate the IPC payload shape before passing it to the local sale
 * transaction. This is a lightweight schema guard, not exhaustive business
 * validation — that lives in completeOfflineSale.
 */
export function validateSaleInput(
  input: unknown,
): { valid: true; data: OfflineSaleInput } | { valid: false; error: string } {
  if (!input || typeof input !== "object") {
    return { valid: false, error: "Sale input must be an object" };
  }

  const data = input as Record<string, unknown>;

  if (!Array.isArray(data.items) || data.items.length === 0) {
    return { valid: false, error: "Sale input must contain at least one item" };
  }

  for (let i = 0; i < data.items.length; i++) {
    const item = data.items[i] as Record<string, unknown> | undefined;
    if (!item || typeof item.productId !== "string" || item.productId.length === 0) {
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
    data: input as OfflineSaleInput,
  };
}

// ---------------------------------------------------------------------------
// IPC channel constants
// ---------------------------------------------------------------------------

export const SALES_CHANNELS = {
  COMPLETE_SALE: "offline:sales:complete",
  GET_SALE: "offline:sales:get",
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
export function registerSalesIpc(getDb: () => Database.Database): void {
  ipcMain.handle(
    SALES_CHANNELS.COMPLETE_SALE,
    (_event, input: unknown): OfflineSaleIpcResult => {
      // Validate IPC payload before touching the database
      const validated = validateSaleInput(input);
      if (!validated.valid) {
        return { success: false, error: validated.error, errorCode: "INVALID_INPUT" };
      }

      try {
        const db = getDb();
        const result: OfflineSaleResult = completeOfflineSale(db, validated.data);

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
        const db = getDb();

        const sale = db.prepare(`
          SELECT id, total, customer, invoice_status, invoice_requested, created_at
          FROM sales WHERE id = ?
        `).get(saleId) as {
          id: string;
          total: string;
          customer: string;
          invoice_status: string;
          invoice_requested: number;
          created_at: string;
        } | undefined;

        if (!sale) {
          return { success: false, error: "Sale not found", errorCode: "NOT_FOUND" };
        }

        // Get items
        const items = db.prepare(`
          SELECT product_id, name, description, quantity, unit_price, subtotal, discount_amount
          FROM sale_items WHERE sale_id = ?
        `).all(saleId) as {
          product_id: string;
          name: string;
          description: string | null;
          quantity: number;
          unit_price: string;
          subtotal: string;
          discount_amount: string;
        }[];

        // Get payments
        const payments = db.prepare(`
          SELECT method, amount FROM sale_payments WHERE sale_id = ?
        `).all(saleId) as { method: string; amount: string }[];

        return {
          success: true,
          sale: {
            id: sale.id,
            total: sale.total,
            customer: sale.customer,
            invoiceStatus: sale.invoice_status,
            createdAt: sale.created_at,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to retrieve sale";
        return { success: false, error: message, errorCode: "SALE_ERROR" };
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
}
