// ---------------------------------------------------------------------------
// Domain: Sales types and pure errors
//
// This file must NOT import Electron, better-sqlite3, or any outer-layer module.
// ---------------------------------------------------------------------------

export interface OfflineSaleItemInput {
  productId: string;
  name: string;
  description?: string;
  quantity: number;
  unitPrice: string;
  subtotal: string;
  discountAmount: string;
}

export interface OfflineSalePaymentInput {
  method: string;
  amount: string;
}

export interface OfflineSaleInput {
  items: OfflineSaleItemInput[];
  payments: OfflineSalePaymentInput[];
  invoiceRequested: boolean;
  total: string;
}

export interface OfflineSaleResultSale {
  id: string;
  total: string;
  customer: string;
  invoiceStatus: string;
  invoiceRequested: boolean;
  createdAt: string;
}

export interface StockMovementResult {
  productId: string;
  quantity: number;
  reason: string;
  saleId: string;
}

export interface OfflineSaleResult {
  sale: OfflineSaleResultSale;
  stockMovements?: StockMovementResult[];
  warnings?: string[];
  outboxId: string;
}

export interface SaleLookupResult {
  id: string;
  total: string;
  customer: string;
  invoiceStatus: string;
  createdAt: string;
}

export interface ListedSale {
  id: string;
  total: string;
  customer: string;
  invoiceStatus: string;
  invoiceRequested: boolean;
  createdAt: string;
  syncStatus?: string | null;
}

export class FiscalBlockedError extends Error {
  constructor() {
    super("Fiscal/invoice sales are not available offline. Please reconnect to complete this sale.");
    this.name = "FiscalBlockedError";
  }
}
