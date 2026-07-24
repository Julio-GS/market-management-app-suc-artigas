// ---------------------------------------------------------------------------
// Application: Sales use-case boundary
//
// Delegates to ISalesRepository. Contains no Electron, SQLite, or validation
// logic. Future Sales business rules should land here behind repository ports.
// ---------------------------------------------------------------------------

import type { ISalesRepository } from "../../domain/sales/sales-repository";
import type { ListedSale, OfflineSaleInput, OfflineSaleResult, SaleLookupResult } from "../../domain/sales/sale";

export class SaleService {
  constructor(private readonly salesRepository: ISalesRepository) {}

  completeSale(input: OfflineSaleInput): OfflineSaleResult {
    return this.salesRepository.completeSale(input);
  }

  getSale(saleId: string): SaleLookupResult | undefined {
    return this.salesRepository.getSaleById(saleId);
  }

  listSales(): ListedSale[] {
    return this.salesRepository.listSales();
  }
}
