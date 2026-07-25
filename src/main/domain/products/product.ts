// ---------------------------------------------------------------------------
// Domain: Product contracts and pure helpers
//
// This file must NOT import Electron, better-sqlite3, or any outer-layer module.
// ---------------------------------------------------------------------------

export interface OfflineProductInput {
  detalle: string;
  costo_neto?: string | null;
  costo_final?: string | null;
  iva?: string | null;
  cambio_costo?: string;
  cambio_precio?: string;
  etiqueta?: string;
  facturable?: boolean;
  maneja_stock?: boolean;
  codigos?: string[];
}

export interface OfflineProductUpdateInput {
  detalle?: string;
  costo_neto?: string | null;
  costo_final?: string | null;
  iva?: string | null;
  cambio_costo?: string;
  cambio_precio?: string;
  etiqueta?: string;
  facturable?: boolean;
  maneja_stock?: boolean;
  codigos?: string[];
}

export interface OfflineProductResult {
  success: boolean;
  product?: {
    id: string;
    detalle: string;
    costoNeto: string | null;
    costoFinal: string | null;
    iva: string | null;
    cambioCosto: string;
    cambioPrecio: string;
    etiqueta: string;
    facturable: boolean;
    manejaStock: boolean;
    codigos: string[];
    pricingMode: string;
    stock?: number | null;
    createdAt: string;
    updatedAt: string;
  };
  error?: string;
  errorCode?: string;
}

export interface ProductSearchFilters {
  search?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers — no Electron, no SQLite, no side effects
// ---------------------------------------------------------------------------

export function sanitizeProductCodes(codigos: readonly string[] | null | undefined): string[] {
  if (!Array.isArray(codigos)) {
    return [];
  }

  const seen = new Set<string>();
  const sanitized: string[] = [];

  for (const code of codigos) {
    if (typeof code !== "string") {
      continue;
    }

    const trimmed = code.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    sanitized.push(trimmed);
  }

  return sanitized;
}
