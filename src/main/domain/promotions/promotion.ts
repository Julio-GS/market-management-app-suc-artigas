// ---------------------------------------------------------------------------
// Domain: Promotion contracts and types
//
// This file must NOT import Electron, better-sqlite3, or any outer-layer module.
// ---------------------------------------------------------------------------

export interface OfflinePromotionInput {
  name: string;
  description?: string | null;
  scope?: string;
  product_id?: string | null;
  type: string;
  discount_percent?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  weekdays?: number[] | null;
}

export interface OfflinePromotionUpdateInput {
  name?: string;
  description?: string | null;
  scope?: string;
  product_id?: string | null;
  type?: string;
  discount_percent?: number | null;
  start_date?: string | null;
  end_date?: string | null;
  weekdays?: number[] | null;
  enabled?: boolean;
}

export interface Promotion {
  id: string;
  name: string;
  description: string | null;
  scope: string;
  productId: string | null;
  type: string;
  discountPercent: number | null;
  startDate: string | null;
  endDate: string | null;
  weekdays: number[] | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OfflinePromotionResult {
  success: boolean;
  promotion?: Promotion;
  error?: string;
}
