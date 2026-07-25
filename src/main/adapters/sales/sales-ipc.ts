// ---------------------------------------------------------------------------
// Adapter: Sales IPC handlers
//
// Owns channel constants, lightweight payload validation, Electron
// registration/unregistration, result mapping, and legacy error codes.
// Delegates write flow to SaleService and detailed read flow to the SQLite repo.
// ---------------------------------------------------------------------------

import { ipcMain } from "electron";
import { SALES_CHANNELS } from "../../../shared/ipc-channels";
import { FiscalBlockedError, type OfflineSaleInput } from "../../domain/sales/sale";
import { OfflineAuthRequiredError } from "../../offline-auth";
import { type SaleService } from "../../application/sales/sale-service";
import type { BusyTracker } from "../../busy-state";
import type { DetailedSaleRecord, SalesSqliteRepository } from "../../infrastructure/persistence/sales-sqlite-repository";

export { SALES_CHANNELS };

export type { OfflineSaleInput };
export interface DetailedListedSale extends DetailedSaleRecord {
  invoiceRequested: boolean;
  syncStatus?: string | null;
}

// ---------------------------------------------------------------------------
// Minimal runtime payload validation
// ---------------------------------------------------------------------------

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
    if (!item || typeof item.productId !== "string" || item.productId.trim().length === 0) {
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
// Result types exposed to the renderer
// ---------------------------------------------------------------------------

export interface OfflineSaleIpcResult {
  success: boolean;
  sale?: DetailedSaleRecord;
  warnings?: string[];
  error?: string;
  errorCode?: string;
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerSalesIpc(
  saleService: SaleService,
  salesRepository: SalesSqliteRepository,
  busyTracker?: BusyTracker,
): void {
  ipcMain.handle(
    SALES_CHANNELS.COMPLETE_SALE,
    async (_event, input: unknown): Promise<OfflineSaleIpcResult> => {
      const validated = validateSaleInput(input);
      if (!validated.valid) {
        return { success: false, error: validated.error, errorCode: "INVALID_INPUT" };
      }

      const run = async (): Promise<OfflineSaleIpcResult> => {
        try {
          const result = saleService.completeSale(validated.data);
          const detailedSale = salesRepository.getDetailedSaleById(result.sale.id);

          return {
            success: true,
            sale: detailedSale ?? {
              id: result.sale.id,
              total: result.sale.total,
              customer: result.sale.customer,
              invoiceStatus: result.sale.invoiceStatus,
              createdAt: result.sale.createdAt,
              updatedAt: result.sale.createdAt,
              items: [],
              paymentMethods: [],
              splitTicketGroups: null,
              cae: null,
              caeVto: null,
              cbteNro: null,
              cbteTipo: null,
              ptoVta: null,
              invoiceRequestedAt: null,
            },
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
      };

      return busyTracker?.runProtectedOperation("sale", "Complete sale", run) ?? run();
    },
  );

  ipcMain.handle(
    SALES_CHANNELS.GET_SALE,
    (_event, saleId: string): OfflineSaleIpcResult => {
      try {
        const sale = salesRepository.getDetailedSaleById(saleId);

        if (!sale) {
          return { success: false, error: "Sale not found", errorCode: "NOT_FOUND" };
        }

        return {
          success: true,
          sale,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to retrieve sale";
        return { success: false, error: message, errorCode: "SALE_ERROR" };
      }
    },
  );

  ipcMain.handle(
    SALES_CHANNELS.LIST_SALES,
    (): DetailedListedSale[] => {
      try {
        const syncStatuses = new Map(
          saleService.listSales().map((sale) => [sale.id, { syncStatus: sale.syncStatus, invoiceRequested: sale.invoiceRequested }]),
        );

        return salesRepository.listDetailedSales().map((sale) => ({
          ...sale,
          invoiceRequested: syncStatuses.get(sale.id)?.invoiceRequested ?? false,
          syncStatus: syncStatuses.get(sale.id)?.syncStatus ?? null,
        }));
      } catch {
        return [];
      }
    },
  );
}

export function unregisterSalesIpc(): void {
  ipcMain.removeHandler(SALES_CHANNELS.COMPLETE_SALE);
  ipcMain.removeHandler(SALES_CHANNELS.GET_SALE);
  ipcMain.removeHandler(SALES_CHANNELS.LIST_SALES);
}
