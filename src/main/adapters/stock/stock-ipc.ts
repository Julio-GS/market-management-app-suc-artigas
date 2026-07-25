import { ipcMain } from "electron"

import { STOCK_CHANNELS } from "../../../shared/ipc-channels"
import type { BusyTracker } from "../../busy-state"
import { OfflineAuthRequiredError } from "../../offline-auth"
import type {
  OfflineStockAdjustmentInput,
  OfflineStockAdjustmentResult,
  OfflineStockMovement,
  StockSqliteRepository,
} from "../../infrastructure/persistence/stock-sqlite-repository"

export { STOCK_CHANNELS }
export type { OfflineStockAdjustmentInput, OfflineStockAdjustmentResult, OfflineStockMovement }

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null
}

export function registerStockIpc(
  stockRepository: StockSqliteRepository,
  busyTracker?: BusyTracker,
): void {
  ipcMain.handle(STOCK_CHANNELS.GET, (_event, productId: string) => {
    try {
      return stockRepository.getStock(productId)
    } catch {
      return null
    }
  })

  ipcMain.handle(STOCK_CHANNELS.ADJUST, (_event, input: unknown): Promise<OfflineStockAdjustmentResult> | OfflineStockAdjustmentResult => {
    const run = async (): Promise<OfflineStockAdjustmentResult> => {
      if (!isRecord(input) || typeof input.productId !== "string" || typeof input.quantity !== "number") {
        return { success: false, error: "Invalid stock adjustment input" }
      }

      try {
        const result = stockRepository.adjust({
          product_id: input.productId,
          quantity: input.quantity,
          reason: typeof input.reason === "string" ? input.reason : undefined,
        })

        return result
      } catch (error) {
        if (error instanceof OfflineAuthRequiredError) {
          return { success: false, error: error.message }
        }

        return {
          success: false,
          error: error instanceof Error ? error.message : "Failed to adjust stock",
        }
      }
    }

    return busyTracker?.runProtectedOperation("write", "Adjust stock", run) ?? run()
  })
}

export function unregisterStockIpc(): void {
  ipcMain.removeHandler(STOCK_CHANNELS.GET)
  ipcMain.removeHandler(STOCK_CHANNELS.ADJUST)
}
