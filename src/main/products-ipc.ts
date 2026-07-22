import { ipcMain } from "electron";
import type Database from "better-sqlite3";
import {
  createOfflineProduct,
  updateOfflineProduct,
  deleteOfflineProduct,
  listOfflineProducts,
  searchOfflineProducts,
  findOfflineProductByCode,
  getOfflineProduct,
  sanitizeProductCodes,
  OfflineAuthRequiredError,
  type OfflineProductInput,
  type OfflineProductUpdateInput,
  type OfflineProductResult,
} from "./products-local";

// Re-export for preload consumers
export type { OfflineProductInput, OfflineProductUpdateInput, OfflineProductResult };

// ---------------------------------------------------------------------------
// Runtime payload validation
// ---------------------------------------------------------------------------

type ValidationResult<T> = { valid: true; data: T } | { valid: false; error: string };

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}

function validateOptionalNullableString(
  data: Record<string, unknown>,
  key: "costo_neto" | "costo_final" | "iva",
): ValidationResult<string | null | undefined> {
  const value = data[key];
  if (value === undefined || value === null) {
    return { valid: true, data: value };
  }
  if (typeof value !== "string") {
    return { valid: false, error: `${key} must be a string or null` };
  }
  return { valid: true, data: value.trim() };
}

function validateOptionalString(
  data: Record<string, unknown>,
  key: "cambio_costo" | "cambio_precio" | "etiqueta",
): ValidationResult<string | undefined> {
  const value = data[key];
  if (value === undefined) {
    return { valid: true, data: undefined };
  }
  if (typeof value !== "string") {
    return { valid: false, error: `${key} must be a string` };
  }
  return { valid: true, data: value.trim() };
}

function validateOptionalBoolean(
  data: Record<string, unknown>,
  key: "facturable" | "maneja_stock",
): ValidationResult<boolean | undefined> {
  const value = data[key];
  if (value === undefined) {
    return { valid: true, data: undefined };
  }
  if (typeof value !== "boolean") {
    return { valid: false, error: `${key} must be a boolean` };
  }
  return { valid: true, data: value };
}

function validateCodigos(data: Record<string, unknown>): ValidationResult<string[] | undefined> {
  const value = data.codigos;
  if (value === undefined) {
    return { valid: true, data: undefined };
  }
  if (!Array.isArray(value) || value.some((code) => typeof code !== "string")) {
    return { valid: false, error: "codigos must be an array of strings" };
  }
  return { valid: true, data: sanitizeProductCodes(value) };
}

export function validateProductCreateInput(input: unknown): ValidationResult<OfflineProductInput> {
  if (!isRecord(input)) {
    return { valid: false, error: "Product input must be an object" };
  }

  if (typeof input.detalle !== "string" || input.detalle.trim().length === 0) {
    return { valid: false, error: "Product input must have a non-empty detalle" };
  }

  const costoNeto = validateOptionalNullableString(input, "costo_neto");
  if (!costoNeto.valid) return costoNeto;
  const costoFinal = validateOptionalNullableString(input, "costo_final");
  if (!costoFinal.valid) return costoFinal;
  const iva = validateOptionalNullableString(input, "iva");
  if (!iva.valid) return iva;
  const cambioCosto = validateOptionalString(input, "cambio_costo");
  if (!cambioCosto.valid) return cambioCosto;
  const cambioPrecio = validateOptionalString(input, "cambio_precio");
  if (!cambioPrecio.valid) return cambioPrecio;
  const etiqueta = validateOptionalString(input, "etiqueta");
  if (!etiqueta.valid) return etiqueta;
  const facturable = validateOptionalBoolean(input, "facturable");
  if (!facturable.valid) return facturable;
  const manejaStock = validateOptionalBoolean(input, "maneja_stock");
  if (!manejaStock.valid) return manejaStock;
  const codigos = validateCodigos(input);
  if (!codigos.valid) return codigos;

  return {
    valid: true,
    data: {
      detalle: input.detalle.trim(),
      costo_neto: costoNeto.data,
      costo_final: costoFinal.data,
      iva: iva.data,
      cambio_costo: cambioCosto.data,
      cambio_precio: cambioPrecio.data,
      etiqueta: etiqueta.data,
      facturable: facturable.data,
      maneja_stock: manejaStock.data,
      codigos: codigos.data,
    },
  };
}

export function validateProductUpdateInput(input: unknown): ValidationResult<OfflineProductUpdateInput> {
  if (!isRecord(input)) {
    return { valid: false, error: "Product update input must be an object" };
  }

  if (input.detalle !== undefined && (typeof input.detalle !== "string" || input.detalle.trim().length === 0)) {
    return { valid: false, error: "detalle must be a non-empty string when provided" };
  }

  const costoNeto = validateOptionalNullableString(input, "costo_neto");
  if (!costoNeto.valid) return costoNeto;
  const costoFinal = validateOptionalNullableString(input, "costo_final");
  if (!costoFinal.valid) return costoFinal;
  const iva = validateOptionalNullableString(input, "iva");
  if (!iva.valid) return iva;
  const cambioCosto = validateOptionalString(input, "cambio_costo");
  if (!cambioCosto.valid) return cambioCosto;
  const cambioPrecio = validateOptionalString(input, "cambio_precio");
  if (!cambioPrecio.valid) return cambioPrecio;
  const etiqueta = validateOptionalString(input, "etiqueta");
  if (!etiqueta.valid) return etiqueta;
  const facturable = validateOptionalBoolean(input, "facturable");
  if (!facturable.valid) return facturable;
  const manejaStock = validateOptionalBoolean(input, "maneja_stock");
  if (!manejaStock.valid) return manejaStock;
  const codigos = validateCodigos(input);
  if (!codigos.valid) return codigos;

  return {
    valid: true,
    data: {
      detalle: input.detalle?.trim(),
      costo_neto: costoNeto.data,
      costo_final: costoFinal.data,
      iva: iva.data,
      cambio_costo: cambioCosto.data,
      cambio_precio: cambioPrecio.data,
      etiqueta: etiqueta.data,
      facturable: facturable.data,
      maneja_stock: manejaStock.data,
      codigos: codigos.data,
    },
  };
}

export function validateProductSearchFilters(input: unknown): ValidationResult<{ search?: string } | undefined> {
  if (input === undefined) {
    return { valid: true, data: undefined };
  }
  if (!isRecord(input)) {
    return { valid: false, error: "Product search filters must be an object" };
  }
  if (input.search !== undefined && typeof input.search !== "string") {
    return { valid: false, error: "search must be a string" };
  }
  return {
    valid: true,
    data: input.search === undefined ? {} : { search: input.search.trim() },
  };
}

export function validateProductCodeLookup(input: unknown): ValidationResult<string> {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { valid: false, error: "Product code must be a non-empty string" };
  }
  return { valid: true, data: input.trim() };
}

// ---------------------------------------------------------------------------
// IPC channel constants
// ---------------------------------------------------------------------------

export const PRODUCTS_CHANNELS = {
  CREATE: "offline:products:create",
  UPDATE: "offline:products:update",
  DELETE: "offline:products:delete",
  LIST: "offline:products:list",
  GET: "offline:products:get",
  FIND_BY_CODE: "offline:products:findByCode",
} as const;

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

export function registerProductsIpc(getDb: () => Database.Database): void {
  ipcMain.handle(
    PRODUCTS_CHANNELS.CREATE,
    (_event, input: unknown): OfflineProductResult => {
      const validated = validateProductCreateInput(input);
      if (!validated.valid) {
        return { success: false, error: validated.error, errorCode: "INVALID_INPUT" };
      }

      try {
        const db = getDb();
        return createOfflineProduct(db, validated.data);
      } catch (err) {
        if (err instanceof OfflineAuthRequiredError) {
          return { success: false, error: err.message, errorCode: "OFFLINE_AUTH_REQUIRED" };
        }
        const message = err instanceof Error ? err.message : "Failed to create product";
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    PRODUCTS_CHANNELS.UPDATE,
    (_event, productId: string, input: unknown): OfflineProductResult => {
      const validated = validateProductUpdateInput(input);
      if (!validated.valid) {
        return { success: false, error: validated.error, errorCode: "INVALID_INPUT" };
      }

      try {
        const db = getDb();
        return updateOfflineProduct(db, productId, validated.data);
      } catch (err) {
        if (err instanceof OfflineAuthRequiredError) {
          return { success: false, error: err.message, errorCode: "OFFLINE_AUTH_REQUIRED" };
        }
        const message = err instanceof Error ? err.message : "Failed to update product";
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    PRODUCTS_CHANNELS.DELETE,
    (_event, productId: string): OfflineProductResult => {
      try {
        const db = getDb();
        return deleteOfflineProduct(db, productId);
      } catch (err) {
        if (err instanceof OfflineAuthRequiredError) {
          return { success: false, error: err.message, errorCode: "OFFLINE_AUTH_REQUIRED" };
        }
        const message = err instanceof Error ? err.message : "Failed to delete product";
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    PRODUCTS_CHANNELS.LIST,
    (_event, filters?: unknown): OfflineProductResult[] => {
      const validated = validateProductSearchFilters(filters);
      if (!validated.valid) {
        return [{ success: false, error: validated.error, errorCode: "INVALID_INPUT" }];
      }

      try {
        const db = getDb();
        return validated.data?.search ? searchOfflineProducts(db, validated.data) : listOfflineProducts(db);
      } catch (err) {
        return [{ success: false, error: err instanceof Error ? err.message : "Failed to list products" }];
      }
    },
  );

  ipcMain.handle(
    PRODUCTS_CHANNELS.FIND_BY_CODE,
    (_event, code: unknown): OfflineProductResult => {
      const validated = validateProductCodeLookup(code);
      if (!validated.valid) {
        return { success: false, error: validated.error, errorCode: "INVALID_INPUT" };
      }

      try {
        const db = getDb();
        return findOfflineProductByCode(db, validated.data);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to find product by code";
        return { success: false, error: message };
      }
    },
  );

  ipcMain.handle(
    PRODUCTS_CHANNELS.GET,
    (_event, productId: string): OfflineProductResult => {
      try {
        const db = getDb();
        return getOfflineProduct(db, productId);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to get product";
        return { success: false, error: message };
      }
    },
  );
}

export function unregisterProductsIpc(): void {
  ipcMain.removeHandler(PRODUCTS_CHANNELS.CREATE);
  ipcMain.removeHandler(PRODUCTS_CHANNELS.UPDATE);
  ipcMain.removeHandler(PRODUCTS_CHANNELS.DELETE);
  ipcMain.removeHandler(PRODUCTS_CHANNELS.LIST);
  ipcMain.removeHandler(PRODUCTS_CHANNELS.GET);
  ipcMain.removeHandler(PRODUCTS_CHANNELS.FIND_BY_CODE);
}
