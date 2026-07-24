// ---------------------------------------------------------------------------
// Domain: Bootstrap snapshot contracts & result types
//
// Types preserved byte-identical from the previous Bootstrap implementation.
// BootstrapStatus is re-exported from the shared cross-cutting module.
// ---------------------------------------------------------------------------

import type { BootstrapStatus } from "../../offline-state";

// Re-export so consumers don't need to reach into offline-state
export type { BootstrapStatus };

// ---------------------------------------------------------------------------
// Bootstrap snapshot contract — mirrors backend POST /sync/bootstrap response
// ---------------------------------------------------------------------------

export interface BootstrapProduct {
  id: string;
  detalle: string;
  costo_neto: string | null;
  costo_final: string | null;
  iva: string | null;
  cambio_costo: string;
  cambio_precio: string;
  etiqueta: string;
  facturable: boolean;
  maneja_stock: boolean;
  codigos: string[];
  pricing_mode: string;
  is_protected: boolean;
  created_at: string;
  updated_at: string;
}

export interface BootstrapStockBalance {
  product_id: string;
  stock_actual: number;
  updated_at: string;
}

export interface BootstrapPromotion {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  product_id: string | null;
  type: string;
  discount_percent: number | null;
  start_date: string | null;
  end_date: string | null;
  weekdays: number[] | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface BootstrapProviderPurchase {
  id: string;
  provider_name: string;
  amount: string;
  payment_method: string | null;
  created_at: string;
  updated_at: string;
}

export interface BootstrapUserProfile {
  id: string;
  username: string;
  created_at: string;
  updated_at: string;
}

export interface BootstrapSnapshot {
  products: BootstrapProduct[];
  stock_balances: BootstrapStockBalance[];
  promotions: BootstrapPromotion[];
  provider_purchases: BootstrapProviderPurchase[];
  user_profile: BootstrapUserProfile;
  sync_cursor: string;
}

// ---------------------------------------------------------------------------
// Bootstrap status result
// ---------------------------------------------------------------------------

export interface BootstrapResult {
  status: BootstrapStatus;
  ready: boolean;
  syncCursor: string | null;
  error?: string;
}
