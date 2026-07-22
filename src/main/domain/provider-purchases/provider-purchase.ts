// ---------------------------------------------------------------------------
// Domain: Provider Purchase contracts and types
//
// This file must NOT import Electron, better-sqlite3, or any outer-layer module.
// ---------------------------------------------------------------------------

export interface OfflineProviderPurchaseInput {
  provider_name: string;
  amount: string;
  payment_method?: string;
}

export interface OfflineProviderPurchaseUpdateInput {
  provider_name?: string;
  amount?: string;
  payment_method?: string | null;
}

export interface OfflineProviderPurchaseRow {
  id: string;
  provider_name: string;
  amount: string;
  payment_method: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProviderPurchase {
  id: string;
  providerName: string;
  amount: string;
  paymentMethod: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OfflineProviderPurchaseResult {
  success: boolean;
  purchase?: ProviderPurchase;
  error?: string;
}
