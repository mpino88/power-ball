/**
 * Whitelist y menús extra por usuario.
 * Persistencia: Google Sheet (si GOOGLE_SHEET_ID + credenciales) o JSON en data/bot-users.json.
 * BOT_OWNER_ID = único administrador; solo usuarios en allowed pueden usar el bot.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import { getPlanByTitle } from "./plans.js";

const CONFIG_DIR = path.join(process.cwd(), "data");
const CONFIG_PATH = path.join(CONFIG_DIR, "bot-users.json");
const STRATEGY_REQUESTS_PATH = path.join(CONFIG_DIR, "strategy-requests.json");

export interface UserInfo {
  name?: string;
  phone?: string;
  plan?: string;
  plan_status?: string;
}

/** Usuarios que solicitaron un plan pero aún no están aprobados (no están en allowed). */
export interface PlanRequest {
  plan: string;
  name?: string;
  phone?: string;
}

interface UsersConfig {
  allowed: number[];
  menus: Record<string, string[]>;
  userInfo: Record<string, UserInfo>;
  /** userId -> { plan }. Solo usuarios con plan_status "requested" (no están en allowed). */
  requestedPlans: Record<string, PlanRequest>;
}

const defaultConfig: UsersConfig = { allowed: [], menus: {}, userInfo: {}, requestedPlans: {} };
let config: UsersConfig = { ...defaultConfig };

/**
 * Estructura del Sheet (y equivalente en bot-users.json):
 * - userId (A), nombre (B), telefono (C).
 * - menus (D): IDs de menús extra separados por coma.
 * - menus_labels (E): texto del botón de cada menú, separados por coma (para mostrar en sheet).
 * - plan (F), plan_status (G).
 * Lógica: plan_status === "requested" → requestedPlans; resto → allowed + userInfo + menus.
 */
const SHEET_HEADERS = ["userId", "nombre", "telefono", "menus", "menus_labels", "plan", "plan_status"] as const;
type SheetRow = { userId: string; nombre: string; telefono: string; menus: string; menus_labels: string; plan: string; plan_status: string };

/** Índices de columnas (mismo orden que SHEET_HEADERS) para leer sin depender del texto exacto del encabezado. */
const COL_USERID = 0;
const COL_NOMBRE = 1;
const COL_TELEFONO = 2;
const COL_MENUS = 3;
const COL_PLAN = 5;
const COL_PLAN_STATUS = 6;

/** Resolver para obtener el texto (label) de un menú por ID. Se asigna desde bot al arranque (getExtraMenuLabel). */
let sheetMenuLabelResolver: ((menuId: string) => string | undefined) | null = null;
export function setSheetMenuLabelResolver(fn: (menuId: string) => string | undefined): void {
  sheetMenuLabelResolver = fn;
}

function useGoogleSheet(): boolean {
  const id = process.env.GOOGLE_SHEET_ID?.trim();
  if (!id) return false;
  const auth = getSheetAuth();
  return auth !== null;
}

/** ID de la Sheet (recortado). Usar en loadFromSheet/saveToSheet. */
function getSheetId(): string | null {
  const id = process.env.GOOGLE_SHEET_ID?.trim();
  return id || null;
}

/** Para logs: indica si estamos usando Sheet o archivo. */
export function getStorageBackend(): "sheet" | "file" {
  return useGoogleSheet() ? "sheet" : "file";
}

/** Razón por la que no se usa Google Sheet (para mostrar al usuario). Null si sí se usa Sheet. */
export function getSheetUnavailableReason(): string | null {
  const id = process.env.GOOGLE_SHEET_ID?.trim();
  if (!id) return "Falta GOOGLE_SHEET_ID en el entorno.";
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (json) {
    try {
      const cred = JSON.parse(json) as { client_email?: string; private_key?: string };
      if (!cred.client_email || !cred.private_key)
        return "GOOGLE_SERVICE_ACCOUNT_JSON debe incluir client_email y private_key.";
      return null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return "GOOGLE_SERVICE_ACCOUNT_JSON inválido (debe ser JSON en una sola línea): " + msg;
    }
  }
  if (email && key) return null;
  return "Falta GOOGLE_SERVICE_ACCOUNT_JSON (o EMAIL + PRIVATE_KEY) en el entorno.";
}

/** Email de la cuenta de servicio (para mensajes de error 404). */
function getSheetClientEmail(): string | null {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (json) {
    try {
      const cred = JSON.parse(json) as { client_email?: string };
      return cred.client_email ?? null;
    } catch {
      return null;
    }
  }
  return process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? null;
}

/** Resultado de persist(): para mostrar en la respuesta al agregar acceso. */
export interface PersistResult {
  backend: "sheet" | "file";
  ok: boolean;
  count: number;
  error?: string;
}

/** Quita saltos de línea literales (p. ej. al pegar en Render). No toca \\n dentro de strings. */
function parseSheetJson(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    const oneLine = json.replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\r/g, " ").trim();
    try {
      return JSON.parse(oneLine) as Record<string, unknown>;
    } catch (e) {
      console.error("[user-config] Error parsing GOOGLE_SERVICE_ACCOUNT_JSON:", e);
      return null;
    }
  }
}

function getSheetAuth(): JWT | null {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (json) {
    const cred = parseSheetJson(json) as { client_email?: string; private_key?: string } | null;
    if (cred?.client_email && cred?.private_key) {
      const privateKey = cred.private_key.replace(/\\n/g, "\n");
      return new JWT({
        email: cred.client_email,
        key: privateKey,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
    }
  }
  if (email && key) {
    const privateKey = key.replace(/\\n/g, "\n");
    return new JWT({
      email,
      key: privateKey,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  }
  return null;
}

async function loadFromSheet(): Promise<UsersConfig> {
  const sheetId = getSheetId();
  if (!sheetId) return { ...defaultConfig };
  const auth = getSheetAuth();
  if (!auth) {
    console.warn("[user-config] Google Sheet: sin credenciales (GOOGLE_SERVICE_ACCOUNT_JSON o EMAIL+PRIVATE_KEY). Usando archivo.");
    return { ...defaultConfig };
  }
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    if (!sheet) {
      console.warn("[user-config] Google Sheet: no hay hojas en el documento.");
      return { ...defaultConfig };
    }
    try {
      await sheet.loadHeaderRow(1);
    } catch {
      await sheet.setHeaderRow([...SHEET_HEADERS], 1);
      console.log("[user-config] Google Sheet: cabecera creada (primera vez).");
      return { ...defaultConfig };
    }
    const rows = await sheet.getRows<SheetRow & { est_grupos?: string; est_individuales?: string }>({
      offset: 0,
      limit: 10000,
    });
    const allowed: number[] = [];
    const menus: Record<string, string[]> = {};
    const userInfo: Record<string, UserInfo> = {};
    const requestedPlans: Record<string, PlanRequest> = {};
    const headers = sheet.headerValues;
    for (const row of rows) {
      const obj = row.toObject() as Record<string, unknown>;
      const values = headers.map((h) => (h ? String(obj[h] ?? "").trim() : ""));
      const getCol = (i: number) =>
        i >= 0 && i < values.length ? String(values[i] ?? "").trim() : "";
      const uidStr = getCol(COL_USERID);
      const uid = parseInt(uidStr, 10);
      if (uidStr === "" || Number.isNaN(uid)) continue;
      const planStatus = getCol(COL_PLAN_STATUS).toLowerCase();
      const planName = getCol(COL_PLAN);
      if (planStatus === "requested") {
        requestedPlans[uidStr] = {
          plan: planName || "—",
          name: getCol(COL_NOMBRE) || undefined,
          phone: getCol(COL_TELEFONO) || undefined,
        };
        continue;
      }
      allowed.push(uid);
      let menuIds: string[] = [];
      const menusStr = getCol(COL_MENUS);
      if (menusStr) menuIds = menusStr.split(",").map((s) => s.trim()).filter(Boolean);
      else {
        const rowObj = row as unknown as Record<string, unknown>;
        const g = String(rowObj.est_grupos ?? "").trim();
        const i = String(rowObj.est_individuales ?? "").trim();
        if (g === "1" || g.toLowerCase() === "true") menuIds.push("est_grupos");
        if (i === "1" || i.toLowerCase() === "true") menuIds.push("est_individuales");
      }
      menus[uidStr] = menuIds;
      userInfo[uidStr] = {
        name: getCol(COL_NOMBRE) || undefined,
        phone: getCol(COL_TELEFONO) || undefined,
        plan: planName || undefined,
        plan_status: planStatus || undefined,
      };
    }
    console.log(
      "[user-config] Google Sheet: cargados",
      allowed.length,
      "usuarios;",
      Object.keys(requestedPlans).length,
      "solicitudes pendientes."
    );
    return { allowed, menus, userInfo, requestedPlans };
  } catch (e) {
    console.error("[user-config] Error al cargar desde Google Sheet:", e);
    return { ...defaultConfig };
  }
}

function loadFromFile(): UsersConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf8");
      const data = JSON.parse(raw) as Partial<UsersConfig>;
      const requestedRaw = data.requestedPlans && typeof data.requestedPlans === "object" ? data.requestedPlans : {};
      const requestedPlans: Record<string, PlanRequest> = {};
      for (const [uid, req] of Object.entries(requestedRaw)) {
        if (req && typeof req === "object" && typeof (req as PlanRequest).plan === "string") {
          requestedPlans[uid] = {
            plan: (req as PlanRequest).plan,
            name: (req as PlanRequest).name,
            phone: (req as PlanRequest).phone,
          };
        }
      }
      return {
        allowed: Array.isArray(data.allowed) ? data.allowed : [],
        menus: data.menus && typeof data.menus === "object" ? data.menus : {},
        userInfo: data.userInfo && typeof data.userInfo === "object" ? data.userInfo : {},
        requestedPlans,
      };
    }
  } catch (e) {
    console.error("Error loading user config:", e);
  }
  return { ...defaultConfig };
}

async function saveToSheet(): Promise<void> {
  const sheetId = getSheetId();
  if (!sheetId) {
    throw new Error("GOOGLE_SHEET_ID no definido o vacío.");
  }
  const auth = getSheetAuth();
  if (!auth) {
    throw new Error("Credenciales no disponibles. Revisa GOOGLE_SERVICE_ACCOUNT_JSON o EMAIL+PRIVATE_KEY.");
  }
  const requestedCount = Object.keys(config.requestedPlans).length;
  console.log("[user-config] Google Sheet: guardando", config.allowed.length, "usuarios permitidos,", requestedCount, "solicitudes pendientes.");
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    if (!sheet) {
      throw new Error("El documento no tiene hojas. Añade al menos una hoja.");
    }
    try {
      await sheet.loadHeaderRow(1);
    } catch {
      /* primera vez o hoja vacía */
    }
    await sheet.setHeaderRow([...SHEET_HEADERS], 1);
    await sheet.clearRows();
    const allowedRows: SheetRow[] = config.allowed.map((uid) => {
      const key = String(uid);
      const menuIds = config.menus[key] ?? [];
      const info = config.userInfo[key];
      const labels = menuIds.map((id) => sheetMenuLabelResolver?.(id) ?? id);
      return {
        userId: key,
        nombre: info?.name ?? "",
        telefono: info?.phone ?? "",
        menus: menuIds.join(","),
        menus_labels: labels.join(", "),
        plan: info?.plan ?? "",
        plan_status: info?.plan_status ?? "approved",
      };
    });
    const requestedRows: SheetRow[] = Object.entries(config.requestedPlans).map(([uid, req]) => ({
      userId: uid,
      nombre: req.name ?? "",
      telefono: req.phone ?? "",
      menus: "",
      menus_labels: "",
      plan: req.plan,
      plan_status: "requested",
    }));
    const rows: SheetRow[] = [...allowedRows, ...requestedRows];
    if (rows.length > 0) {
      if (sheet.title.includes(":")) {
        const msg = "[user-config] Google Sheet: renombra la hoja y quita el carácter ':' del título (la API de Google falla si el nombre tiene ':').";
        console.error(msg);
        throw new Error(msg);
      }
      await sheet.addRows(rows);
      console.log("[user-config] Google Sheet: guardadas", rows.length, "filas (allowed + requested).");
    } else {
      console.log("[user-config] Google Sheet: 0 usuarios, solo cabecera.");
    }
  } catch (e) {
    const err = e as Error;
    const msg = err?.message ?? String(e);
    console.error("[user-config] Error al guardar en Google Sheet:", msg);
    if (msg.includes("404") || msg.includes("not found")) {
      const email = getSheetClientEmail();
      const hint = email
        ? ` 1) En Render, variable GOOGLE_SHEET_ID = ID de la hoja (ej: 12zXYV7G9Pg3n3_Fu-pMG67z6xGUlSbuY-Yfa94bzrI8), sin espacios. 2) En Google: abre la hoja → Compartir → añade ${email} como Editor.`
        : " 1) GOOGLE_SHEET_ID = ID de la hoja en Render. 2) Comparte la hoja con el client_email de la cuenta de servicio (Editor).";
      throw new Error("Hoja no encontrada (404)." + hint);
    }
    if (msg.includes("403") || msg.includes("Forbidden") || msg.includes("Permission denied")) {
      const email = getSheetClientEmail();
      const hint = email
        ? ` Comparte la hoja con ${email} como Editor.`
        : " Comparte la hoja con el client_email de tu cuenta de servicio (Editor).";
      throw new Error("Sin permiso para escribir (403)." + hint);
    }
    if (msg.includes(":")) console.error("[user-config] Si el error menciona 'colon', renombra la hoja y quita los ':' del título.");
    throw e;
  }
}

function saveToFile(): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(
      CONFIG_PATH,
      JSON.stringify(
        { allowed: config.allowed, menus: config.menus, userInfo: config.userInfo, requestedPlans: config.requestedPlans },
        null,
        2
      ),
      "utf8"
    );
  } catch (e) {
    console.error("Error saving user config:", e);
  }
}

async function persist(): Promise<PersistResult> {
  const backend = getStorageBackend();
  const count = config.allowed.length;
  console.log("[user-config] persist: backend=" + backend + ", usuarios=" + count);
  if (backend === "sheet") {
    try {
      await saveToSheet();
      return { backend: "sheet", ok: true, count };
    } catch (e) {
      const err = e as Error;
      const msg = err?.message ?? String(e);
      console.error("[user-config] persist: fallo al guardar en Google Sheet.", e);
      return { backend: "sheet", ok: false, count, error: msg };
    }
  } else {
    try {
      saveToFile();
      return { backend: "file", ok: true, count };
    } catch (e) {
      const err = e as Error;
      return { backend: "file", ok: false, count, error: err?.message ?? String(e) };
    }
  }
}

/** Carga la config desde Sheet o archivo. Llamar al arranque del bot. */
export async function initUserConfig(): Promise<void> {
  const sheetId = getSheetId();
  const hasAuth = getSheetAuth() !== null;
  if (sheetId && !hasAuth) {
    console.warn(
      "[user-config] GOOGLE_SHEET_ID está definido pero las credenciales fallan o no están. " +
        "Revisa GOOGLE_SERVICE_ACCOUNT_JSON (JSON en una línea) o EMAIL+PRIVATE_KEY. Los datos se guardarán solo en archivo."
    );
  }
  if (useGoogleSheet()) {
    console.log("[user-config] Usando Google Sheet. ID:", sheetId);
    config = await loadFromSheet();
    try {
      await saveToSheet();
      console.log("[user-config] Google Sheet: verificación de escritura OK.");
    } catch (e) {
      console.error("[user-config] Google Sheet: verificación de escritura FALLO (al guardar usuarios fallará):", (e as Error)?.message ?? e);
    }
  } else {
    console.log("[user-config] Usando archivo:", CONFIG_PATH);
    config = loadFromFile();
  }
}

/** Fila de la 2ª pestaña (Estrategias): id, titulo, descripcion, createdBy, price, status (public|private). Por defecto status=private al crear. */
export interface StrategyRow {
  id: string;
  titulo: string;
  descripcion?: string;
  createdBy?: number;
  price?: string;
  /** En el Sheet se guarda como columna "status"; "private" por defecto al crear. */
  visibility?: string;
}

const STRATEGIES_SHEET_TITLE = "Estrategias";
/** status = "private" | "public"; las nuevas estrategias se crean como private por defecto. */
const STRATEGIES_HEADERS = ["id", "titulo", "descripcion", "createdBy", "price", "status"] as const;

/** Carga estrategias desde la 2ª pestaña de la hoja de cálculo. Si no hay Sheet o la pestaña no existe, la crea y devuelve []. */
export async function loadStrategiesFromSheet(): Promise<StrategyRow[]> {
  const sheetId = getSheetId();
  if (!sheetId) return [];
  const auth = getSheetAuth();
  if (!auth) return [];
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByIndex[1];
    if (!sheet) {
      await doc.addSheet({
        title: STRATEGIES_SHEET_TITLE,
        headerValues: [...STRATEGIES_HEADERS],
      });
      console.log("[user-config] Hoja de cálculo: pestaña «Estrategias» creada (2ª pestaña).");
      return [];
    }
    try {
      await sheet.loadHeaderRow(1);
    } catch {
      await sheet.setHeaderRow([...STRATEGIES_HEADERS], 1);
      return [];
    }
    let headers = sheet.headerValues;
    if (headers.length < STRATEGIES_HEADERS.length) {
      await sheet.setHeaderRow([...STRATEGIES_HEADERS], 1);
      headers = [...STRATEGIES_HEADERS];
    }
    const rows = await sheet.getRows({ offset: 0, limit: 5000 });
    const result: StrategyRow[] = [];
    for (const row of rows) {
      const obj = row.toObject() as Record<string, unknown>;
      const values = headers.map((h) => (h ? String(obj[h] ?? "").trim() : ""));
      const id = values[0] ?? "";
      const titulo = values[1] ?? "";
      if (!id) continue;
      const desc = values[2] ?? "";
      const createdByStr = values[3] ?? "";
      const createdBy = createdByStr ? parseInt(createdByStr, 10) : undefined;
      const price = values[4]?.trim() || undefined;
      const visibility = values[5]?.trim() || undefined;
      result.push({
        id,
        titulo: titulo || id,
        descripcion: desc || undefined,
        createdBy: Number.isNaN(createdBy as number) ? undefined : (createdBy as number),
        price: price || undefined,
        visibility: visibility || undefined,
      });
    }
    console.log("[user-config] Estrategias: cargadas", result.length, "desde 2ª pestaña.");
    return result;
  } catch (e) {
    console.error("[user-config] Error al cargar estrategias desde Sheet:", (e as Error)?.message ?? e);
    return [];
  }
}

/** Guarda estrategias en la 2ª pestaña (id, titulo, descripcion, createdBy, price, status). status=public|private; por defecto private al crear. */
export async function saveStrategiesToSheet(items: StrategyRow[]): Promise<void> {
  const sheetId = getSheetId();
  if (!sheetId) return;
  const auth = getSheetAuth();
  if (!auth) return;
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByIndex[1];
    if (!sheet) {
      sheet = await doc.addSheet({
        title: STRATEGIES_SHEET_TITLE,
        headerValues: [...STRATEGIES_HEADERS],
      });
    }
    await sheet.setHeaderRow([...STRATEGIES_HEADERS], 1);
    await sheet.clearRows();
    if (items.length > 0) {
      const rows = items.map((r) => ({
        id: r.id,
        titulo: r.titulo,
        descripcion: r.descripcion ?? "",
        createdBy: r.createdBy !== undefined && r.createdBy !== null ? String(r.createdBy) : "",
        price: r.price ?? "",
        status: r.visibility ?? "private",
      }));
      await sheet.addRows(rows);
    }
    console.log("[user-config] Estrategias: guardadas", items.length, "en 2ª pestaña.");
  } catch (e) {
    console.error("[user-config] Error al guardar estrategias en Sheet:", (e as Error)?.message ?? e);
  }
}

/** Fila de la 3ª pestaña (Planes): id, title, description, price, menuIds (IDs separados por coma). */
export interface PlanRow {
  id: string;
  title: string;
  description: string;
  price: string;
  menuIds: string;
}

const PLANS_SHEET_TITLE = "Planes";
const PLANS_HEADERS = ["id", "title", "description", "price", "menuIds"] as const;

/** Carga planes desde la 3ª pestaña. Si no existe, la crea y devuelve []. */
export async function loadPlansFromSheet(): Promise<PlanRow[]> {
  const sheetId = getSheetId();
  if (!sheetId) return [];
  const auth = getSheetAuth();
  if (!auth) return [];
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByIndex[2];
    if (!sheet) {
      await doc.addSheet({
        title: PLANS_SHEET_TITLE,
        headerValues: [...PLANS_HEADERS],
      });
      console.log("[user-config] Hoja de cálculo: pestaña «Planes» creada (3ª pestaña).");
      return [];
    }
    try {
      await sheet.loadHeaderRow(1);
    } catch {
      await sheet.setHeaderRow([...PLANS_HEADERS], 1);
      return [];
    }
    const rows = await sheet.getRows({ offset: 0, limit: 500 });
    const headers = sheet.headerValues;
    const result: PlanRow[] = [];
    const seenIds = new Set<string>();
    for (const row of rows) {
      const obj = row.toObject() as Record<string, unknown>;
      const values = headers.map((h) => (h ? String(obj[h] ?? "").trim() : ""));
      const id = values[0] ?? "";
      const title = values[1] ?? "";
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      result.push({
        id,
        title: title || id,
        description: values[2] ?? "",
        price: values[3] ?? "",
        menuIds: values[4] ?? "",
      });
    }
    console.log("[user-config] Planes: cargados", result.length, "desde 3ª pestaña.");
    return result;
  } catch (e) {
    console.error("[user-config] Error al cargar planes desde Sheet:", (e as Error)?.message ?? e);
    return [];
  }
}

/** Guarda planes en la 3ª pestaña (id, title, description, price, menuIds). */
export async function savePlansToSheet(items: PlanRow[]): Promise<void> {
  const sheetId = getSheetId();
  if (!sheetId) return;
  const auth = getSheetAuth();
  if (!auth) return;
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByIndex[2];
    if (!sheet) {
      sheet = await doc.addSheet({
        title: PLANS_SHEET_TITLE,
        headerValues: [...PLANS_HEADERS],
      });
    }
    await sheet.setHeaderRow([...PLANS_HEADERS], 1);
    await sheet.clearRows();
    if (items.length > 0) {
      const rows = items.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description ?? "",
        price: r.price ?? "",
        menuIds: r.menuIds ?? "",
      }));
      await sheet.addRows(rows);
    }
    console.log("[user-config] Planes: guardados", items.length, "en 3ª pestaña.");
  } catch (e) {
    console.error("[user-config] Error al guardar planes en Sheet:", (e as Error)?.message ?? e);
  }
}

/** Recarga la config desde el Sheet (o archivo) y reemplaza la en memoria. Útil para ver datos actualizados (p. ej. solicitudes pendientes). */
export async function reloadConfigFromStorage(): Promise<void> {
  if (useGoogleSheet()) {
    try {
      const loaded = await loadFromSheet();
      config = loaded;
      const n = Object.keys(config.requestedPlans).length;
      console.log("[user-config] reloadConfigFromStorage: recargado desde Sheet;", n, "solicitudes pendientes.");
    } catch (e) {
      console.error("[user-config] reloadConfigFromStorage: error al recargar desde Sheet:", (e as Error)?.message ?? e);
    }
  } else {
    config = loadFromFile();
    console.log("[user-config] reloadConfigFromStorage: recargado desde archivo;", Object.keys(config.requestedPlans).length, "solicitudes pendientes.");
  }
}

export function getOwnerId(): number | null {
  const id = process.env.BOT_OWNER_ID;
  if (!id) return null;
  const n = parseInt(id, 10);
  return Number.isNaN(n) ? null : n;
}

export function isAllowed(userId: number): boolean {
  const owner = getOwnerId();
  if (owner === null) return true;
  if (userId === owner) return true;
  return config.allowed.includes(userId);
}

/** IDs de menús asignados explícitamente al usuario (columna menus). No incluye los del plan. */
export function getUserAssignedMenuIds(userId: number): string[] {
  const list = config.menus[String(userId)];
  return Array.isArray(list) ? [...list] : [];
}

/** Quita un menú de la asignación del usuario (solo columna menus). No elimina la estrategia del sistema. */
export async function removeMenuFromUser(userId: number, menuId: string): Promise<PersistResult> {
  const key = String(userId);
  const current = config.menus[key] ?? [];
  if (!current.includes(menuId)) return { backend: getStorageBackend(), ok: true, count: config.allowed.length };
  config.menus[key] = current.filter((m) => m !== menuId);
  return persist();
}

/**
 * Revisa tras cargar config y planes: para cada usuario con plan, quita de config.menus
 * los menuIds que ya vienen del plan, para que la columna menus solo tenga asignaciones extra.
 * Así getExtraMenus = plan + menus queda bien. Si hubo cambios, persiste.
 */
export async function normalizeUserMenusAfterLoad(): Promise<void> {
  let changed = false;
  for (const uid of config.allowed) {
    const key = String(uid);
    const planTitle = config.userInfo[key]?.plan;
    const plan = planTitle ? getPlanByTitle(planTitle) : undefined;
    const planMenuIds = new Set(plan?.menuIds ?? []);
    if (planMenuIds.size === 0) continue;
    const current = config.menus[key] ?? [];
    const onlyExtras = current.filter((id) => !planMenuIds.has(id));
    if (onlyExtras.length !== current.length) {
      config.menus[key] = onlyExtras;
      changed = true;
    }
  }
  if (changed) await persist();
}

/** Menús del usuario = menús de su plan + menús asignados explícitamente (columna menus). */
export function getExtraMenus(userId: number): string[] {
  const planTitle = getPlan(userId);
  const plan = planTitle ? getPlanByTitle(planTitle) : undefined;
  const planMenuIds = plan?.menuIds ?? [];
  const assignedMenus = config.menus[String(userId)];
  const assigned = Array.isArray(assignedMenus) ? assignedMenus : [];
  const combined = new Set<string>([...planMenuIds, ...assigned]);
  return Array.from(combined);
}

export function getAllowedUsers(): number[] {
  return [...config.allowed];
}

export function getUsername(userId: number): string | undefined {
  return config.userInfo[String(userId)]?.name;
}

export function getPhone(userId: number): string | undefined {
  return config.userInfo[String(userId)]?.phone;
}

export function getPlan(userId: number): string | undefined {
  return config.userInfo[String(userId)]?.plan;
}

export function getPlanStatus(userId: number): string | undefined {
  return config.userInfo[String(userId)]?.plan_status;
}

export async function setUserInfo(userId: number, info: UserInfo): Promise<PersistResult> {
  const key = String(userId);
  config.userInfo[key] = { ...config.userInfo[key], ...info };
  return persist();
}

export async function addAllowed(userId: number): Promise<PersistResult> {
  if (!config.allowed.includes(userId)) {
    config.allowed.push(userId);
    return persist();
  }
  return { backend: getStorageBackend(), ok: true, count: config.allowed.length };
}

export async function removeAllowed(userId: number): Promise<PersistResult> {
  config.allowed = config.allowed.filter((id) => id !== userId);
  const key = String(userId);
  delete config.userInfo[key];
  delete config.menus[key];
  return persist();
}

export async function setExtraMenus(userId: number, menuIds: string[]): Promise<PersistResult> {
  const key = String(userId);
  config.menus[key] = [...menuIds];
  return persist();
}

/** Registra solicitud de plan (columnas plan, plan_status=requested, nombre, telefono). */
export async function addPlanRequest(
  userId: number,
  planName: string,
  opts?: { name?: string; phone?: string }
): Promise<PersistResult> {
  const key = String(userId);
  const existing = config.requestedPlans[key];
  config.requestedPlans[key] = {
    plan: planName,
    name: opts?.name ?? existing?.name,
    phone: opts?.phone ?? existing?.phone,
  };
  return persist();
}

/** Lista de usuarios con plan_status "requested" (pendientes de aprobación). */
export function getRequestedPlanUsers(): { userId: number; plan: string; name?: string; phone?: string }[] {
  return Object.entries(config.requestedPlans).map(([uid, req]) => ({
    userId: parseInt(uid, 10),
    plan: req.plan,
    name: req.name,
    phone: req.phone,
  }));
}

/** Asigna un plan directamente a un usuario (por el dueño). Le da acceso y plan/plan_status=approved. Los menús del plan se aplican vía getExtraMenus; no se sobrescribe la asignación individual (menus). */
export async function assignPlanToUser(
  targetUserId: number,
  planName: string,
  _planMenuIds: string[]
): Promise<PersistResult> {
  const key = String(targetUserId);
  if (!config.allowed.includes(targetUserId)) config.allowed.push(targetUserId);
  delete config.requestedPlans[key];
  config.userInfo[key] = { ...config.userInfo[key], plan: planName, plan_status: "approved" };
  return persist();
}

/** Usuario con acceso solicita cambio de plan: se quita de allowed, se añade a requestedPlans (plan nuevo, nombre/teléfono actuales) y se persiste. Deja de tener acceso hasta que lo aprueben. */
export async function requestPlanChange(userId: number, planName: string): Promise<PersistResult> {
  const key = String(userId);
  const info = config.userInfo[key];
  config.allowed = config.allowed.filter((id) => id !== userId);
  config.requestedPlans[key] = {
    plan: planName,
    name: info?.name,
    phone: info?.phone,
  };
  return persist();
}

/** Aprueba solicitud: quita de requestedPlans, añade a allowed y guarda plan/plan_status=approved. Los menús del plan se aplican vía getExtraMenus; la asignación individual (menus) no se sobrescribe. */
export async function approvePlanRequest(userId: number, _planMenuIds?: string[]): Promise<PersistResult> {
  const key = String(userId);
  const req = config.requestedPlans[key];
  if (!req) {
    return { backend: getStorageBackend(), ok: false, count: config.allowed.length, error: "Usuario no está en solicitudes pendientes." };
  }
  delete config.requestedPlans[key];
  if (!config.allowed.includes(userId)) config.allowed.push(userId);
  config.userInfo[key] = {
    ...config.userInfo[key],
    name: req.name ?? config.userInfo[key]?.name,
    phone: req.phone ?? config.userInfo[key]?.phone,
    plan: req.plan,
    plan_status: "approved",
  };
  return persist();
}

export async function toggleExtraMenu(userId: number, menuId: string): Promise<boolean> {
  const key = String(userId);
  const current = config.menus[key] ?? [];
  const has = current.includes(menuId);
  if (has) {
    config.menus[key] = current.filter((m) => m !== menuId);
  } else {
    config.menus[key] = [...current, menuId];
  }
  await persist();
  return !has;
}

/** Quita un menú de todos los usuarios (p. ej. al eliminar el menú). */
export async function removeMenuFromAllUsers(menuId: string): Promise<void> {
  let changed = false;
  for (const key of Object.keys(config.menus)) {
    const before = config.menus[key].length;
    config.menus[key] = config.menus[key].filter((m) => m !== menuId);
    if (config.menus[key].length !== before) changed = true;
  }
  if (changed) await persist();
}

/** Solicitud de estrategia (usuario pide acceso; solo el dueño puede aprobar). */
export interface StrategyRequest {
  userId: number;
  menuId: string;
  requestedAt: number;
}

const STRATEGY_REQUESTS_SHEET_TITLE = "SolicitudesEstrategias";
const STRATEGY_REQUESTS_HEADERS = ["userId", "menuId", "requestedAt"] as const;
const STRATEGY_REQUESTS_SHEET_INDEX = 3;

function loadStrategyRequestsSync(): StrategyRequest[] {
  try {
    if (existsSync(STRATEGY_REQUESTS_PATH)) {
      const raw = readFileSync(STRATEGY_REQUESTS_PATH, "utf8");
      const data = JSON.parse(raw) as { requests?: StrategyRequest[] };
      return Array.isArray(data.requests) ? data.requests : [];
    }
  } catch (e) {
    console.error("[user-config] Error al cargar solicitudes de estrategias:", e);
  }
  return [];
}

function saveStrategyRequestsSync(requests: StrategyRequest[]): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(STRATEGY_REQUESTS_PATH, JSON.stringify({ requests }, null, 2), "utf8");
  } catch (e) {
    console.error("[user-config] Error al guardar solicitudes de estrategias:", e);
  }
}

/** Carga solicitudes de estrategias desde la 4ª pestaña del Sheet. */
export async function loadStrategyRequestsFromSheet(): Promise<StrategyRequest[]> {
  const sheetId = getSheetId();
  if (!sheetId) return [];
  const auth = getSheetAuth();
  if (!auth) return [];
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByIndex[STRATEGY_REQUESTS_SHEET_INDEX];
    if (!sheet) {
      await doc.addSheet({
        title: STRATEGY_REQUESTS_SHEET_TITLE,
        headerValues: [...STRATEGY_REQUESTS_HEADERS],
      });
      console.log("[user-config] Hoja de cálculo: pestaña «SolicitudesEstrategias» creada (4ª pestaña).");
      return [];
    }
    try {
      await sheet.loadHeaderRow(1);
    } catch {
      await sheet.setHeaderRow([...STRATEGY_REQUESTS_HEADERS], 1);
      return [];
    }
    const rows = await sheet.getRows({ offset: 0, limit: 2000 });
    const headers = sheet.headerValues;
    const result: StrategyRequest[] = [];
    for (const row of rows) {
      const obj = row.toObject() as Record<string, unknown>;
      const values = headers.map((h) => (h ? String(obj[h] ?? "").trim() : ""));
      const userIdStr = values[0] ?? "";
      const menuId = values[1] ?? "";
      const requestedAtStr = values[2] ?? "";
      if (!userIdStr || !menuId) continue;
      const userId = parseInt(userIdStr, 10);
      const requestedAt = requestedAtStr ? parseInt(requestedAtStr, 10) : Date.now();
      if (Number.isNaN(userId)) continue;
      result.push({ userId, menuId, requestedAt: Number.isNaN(requestedAt) ? Date.now() : requestedAt });
    }
    return result;
  } catch (e) {
    console.error("[user-config] Error al cargar solicitudes de estrategias desde Sheet:", (e as Error)?.message ?? e);
    return [];
  }
}

/** Guarda solicitudes de estrategias en la 4ª pestaña del Sheet. */
export async function saveStrategyRequestsToSheet(requests: StrategyRequest[]): Promise<void> {
  const sheetId = getSheetId();
  if (!sheetId) return;
  const auth = getSheetAuth();
  if (!auth) return;
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByIndex[STRATEGY_REQUESTS_SHEET_INDEX];
    if (!sheet) {
      sheet = await doc.addSheet({
        title: STRATEGY_REQUESTS_SHEET_TITLE,
        headerValues: [...STRATEGY_REQUESTS_HEADERS],
      });
    }
    await sheet.setHeaderRow([...STRATEGY_REQUESTS_HEADERS], 1);
    await sheet.clearRows();
    if (requests.length > 0) {
      const rows = requests.map((r) => ({
        userId: String(r.userId),
        menuId: r.menuId,
        requestedAt: String(r.requestedAt),
      }));
      await sheet.addRows(rows);
    }
    console.log("[user-config] Solicitudes de estrategias: guardadas", requests.length, "en 4ª pestaña.");
  } catch (e) {
    console.error("[user-config] Error al guardar solicitudes de estrategias en Sheet:", (e as Error)?.message ?? e);
  }
}

/** Carga solicitudes (desde Sheet si aplica, si no desde archivo). */
export async function getStrategyRequests(): Promise<StrategyRequest[]> {
  if (useGoogleSheet()) return loadStrategyRequestsFromSheet();
  return loadStrategyRequestsSync();
}

/** Añade una solicitud de estrategia (evita duplicados userId+menuId). */
export async function addStrategyRequest(userId: number, menuId: string): Promise<boolean> {
  const list = useGoogleSheet() ? await loadStrategyRequestsFromSheet() : loadStrategyRequestsSync();
  if (list.some((r) => r.userId === userId && r.menuId === menuId)) return false;
  list.push({ userId, menuId, requestedAt: Date.now() });
  if (useGoogleSheet()) await saveStrategyRequestsToSheet(list);
  else saveStrategyRequestsSync(list);
  return true;
}

/** Elimina una solicitud (al aprobar o rechazar). */
export async function removeStrategyRequest(userId: number, menuId: string): Promise<boolean> {
  const list = useGoogleSheet() ? await loadStrategyRequestsFromSheet() : loadStrategyRequestsSync();
  const next = list.filter((r) => !(r.userId === userId && r.menuId === menuId));
  if (next.length >= list.length) return false;
  if (useGoogleSheet()) await saveStrategyRequestsToSheet(next);
  else saveStrategyRequestsSync(next);
  return true;
}

/** Aprobación: asigna el menú al usuario y quita la solicitud. */
export async function approveStrategyRequest(userId: number, menuId: string): Promise<PersistResult> {
  await toggleExtraMenu(userId, menuId);
  await removeStrategyRequest(userId, menuId);
  return persist();
}

export function isOwner(userId: number): boolean {
  const owner = getOwnerId();
  return owner !== null && userId === owner;
}
