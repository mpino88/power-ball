/**
 * Módulo de Formas de Pago.
 * Persistencia: pestaña 9ª del Google Sheet ("Formas de pago"), columnas: id, description, account, currency.
 */

import { GoogleSpreadsheet } from "google-spreadsheet";
import { getSheetAuth, getStorageBackend } from "./user-config.js";

const PM_SHEET_TITLE = "Formas de pago";
const PM_SHEET_INDEX = 8; // 0-indexed → 9ª pestaña
const PM_HEADERS = ["id", "description", "account", "currency"] as const;

export interface PaymentMethod {
  id: string;
  description: string;
  account: string;
  currency: string;
}

let pmCache: PaymentMethod[] = [];

function getSheetId(): string | undefined {
  return process.env.GOOGLE_SHEET_ID;
}

function newPmId(): string {
  return `pm_${Date.now()}`;
}

// ─── In-memory CRUD ───────────────────────────────────────────────────────────

export function getPaymentMethods(): PaymentMethod[] {
  return [...pmCache];
}

export function getPaymentMethodById(id: string): PaymentMethod | undefined {
  return pmCache.find((p) => p.id === id);
}

function addPm(description: string, account: string, currency: string): PaymentMethod {
  const pm: PaymentMethod = { id: newPmId(), description, account, currency };
  pmCache.push(pm);
  return pm;
}

function updatePm(id: string, description: string, account: string, currency: string): boolean {
  const idx = pmCache.findIndex((p) => p.id === id);
  if (idx === -1) return false;
  pmCache[idx] = { id, description, account, currency };
  return true;
}

function deletePm(id: string): boolean {
  const before = pmCache.length;
  pmCache = pmCache.filter((p) => p.id !== id);
  return pmCache.length < before;
}

// ─── Sheet persistence ────────────────────────────────────────────────────────

/** Carga formas de pago desde la 9ª pestaña del Sheet y rellena el caché. */
export async function loadPaymentMethodsFromSheet(): Promise<PaymentMethod[]> {
  const sheetId = getSheetId();
  if (!sheetId || getStorageBackend() !== "sheet") return pmCache;
  const auth = getSheetAuth();
  if (!auth) return pmCache;
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByIndex[PM_SHEET_INDEX];
    if (!sheet) {
      await doc.addSheet({ title: PM_SHEET_TITLE, headerValues: [...PM_HEADERS] });
      console.log("[payment-methods] Pestaña 'Formas de pago' creada (9ª).");
      pmCache = [];
      return [];
    }
    try { await sheet.loadHeaderRow(1); } catch {
      await sheet.setHeaderRow([...PM_HEADERS], 1);
      pmCache = [];
      return [];
    }
    const rows = await sheet.getRows({ offset: 0, limit: 500 });
    const headers = sheet.headerValues;
    const result: PaymentMethod[] = [];
    for (const row of rows) {
      const obj = row.toObject() as Record<string, unknown>;
      const vals = headers.map((h) => (h ? String(obj[h] ?? "").trim() : ""));
      const id = vals[0] ?? "";
      if (!id) continue;
      result.push({ id, description: vals[1] ?? "", account: vals[2] ?? "", currency: vals[3] ?? "" });
    }
    pmCache = result;
    console.log("[payment-methods] Cargadas", result.length, "formas de pago.");
    return result;
  } catch (e) {
    console.error("[payment-methods] Error al cargar:", (e as Error)?.message ?? e);
    return pmCache;
  }
}

async function savePms(): Promise<void> {
  const sheetId = getSheetId();
  if (!sheetId || getStorageBackend() !== "sheet") return;
  const auth = getSheetAuth();
  if (!auth) return;
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByIndex[PM_SHEET_INDEX];
    if (!sheet) {
      sheet = await doc.addSheet({ title: PM_SHEET_TITLE, headerValues: [...PM_HEADERS] });
    }
    await sheet.setHeaderRow([...PM_HEADERS], 1);
    await sheet.clearRows();
    if (pmCache.length > 0) {
      await sheet.addRows(pmCache.map((p) => ({ id: p.id, description: p.description, account: p.account, currency: p.currency })));
    }
    console.log("[payment-methods] Guardadas", pmCache.length, "formas de pago.");
  } catch (e) {
    console.error("[payment-methods] Error al guardar:", (e as Error)?.message ?? e);
  }
}

// ─── Public async CRUD ────────────────────────────────────────────────────────

export async function addAndSavePaymentMethod(description: string, account: string, currency: string): Promise<PaymentMethod> {
  const pm = addPm(description, account, currency);
  await savePms();
  return pm;
}

export async function updateAndSavePaymentMethod(id: string, description: string, account: string, currency: string): Promise<boolean> {
  const ok = updatePm(id, description, account, currency);
  if (ok) await savePms();
  return ok;
}

export async function deleteAndSavePaymentMethod(id: string): Promise<boolean> {
  const ok = deletePm(id);
  if (ok) await savePms();
  return ok;
}
