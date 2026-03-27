/**
 * Módulo de Formas de Pago.
 * Persistencia: PostgreSQL (DATABASE_URL).
 */

export interface PaymentMethod {
  id: string;
  description: string;
  account: string;
  currency: string;
}

let pmCache: PaymentMethod[] = [];

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

// ─── PG persistence ──────────────────────────────────────────────────────────

/** Carga formas de pago desde PostgreSQL y rellena el caché. */
export async function loadPaymentMethodsFromDB(): Promise<PaymentMethod[]> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresPaymentMethodRepository.js");
    pmCache = await pg.loadPaymentMethodsFromPG();
    return pmCache;
  }
  return pmCache;
}

async function savePms(): Promise<void> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresPaymentMethodRepository.js");
    return pg.savePaymentMethodsToPG(pmCache);
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
