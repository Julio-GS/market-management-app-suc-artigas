// ---------------------------------------------------------------------------
// Domain: Sales repository port
//
// Defines the persistence contract for Sales operations without a DB handle.
// Infrastructure adapters implement this port.
// ---------------------------------------------------------------------------

import type { ListedSale, OfflineSaleInput, OfflineSaleResult, SaleLookupResult } from "./sale";

export interface ISalesRepository {
  completeSale(input: OfflineSaleInput): OfflineSaleResult;
  getSaleById(saleId: string): SaleLookupResult | undefined;
  listSales(): ListedSale[];
}
