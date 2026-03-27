/**
 * Whitelist y menús extra por usuario.
 * Persistencia: Google Sheet (si GOOGLE_SHEET_ID + credenciales) o JSON en data/bot-users.json.
 * BOT_OWNER_ID = único administrador; solo usuarios en allowed pueden usar el bot.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";
import { getPlanByTitle, computeExpiryDate, formatDateMMDDYY } from "./plans.js";
import { isCustomMenu, adjustSubscriberCount, getMenuCreatedBy } from "./custom-menus.js";

const CONFIG_DIR = path.join(process.cwd(), "data");
const CONFIG_PATH = path.join(CONFIG_DIR, "bot-users.json");
const STRATEGY_REQUESTS_PATH = path.join(CONFIG_DIR, "strategy-requests.json");

export interface UserInfo {
  name?: string;
  phone?: string;
  plan?: string;
  plan_status?: string;
  /** Plan solicitado para cambio. Formato: "PlanTitle" o "PlanTitle|temporality". */
  pending_plan?: string;
  /** Temporalidad del plan activo: 1m, 3m, 6m, 1a. */
  plan_temporality?: string;
  /** Fecha de caducidad del plan activo en formato MM/DD/YY. */
  plan_expiry?: string;
  /** true si el usuario ya activó un plan Trial (7d). Solo puede activarse una vez por ID. */
  trial_used?: boolean;
  role?: string;
}

/** Usuarios que solicitaron un plan pero aún no están aprobados (no están en allowed). */
export interface PlanRequest {
  plan: string;
  name?: string;
  phone?: string;
  /** Temporalidad solicitada: 1m, 3m, 6m, 1a. */
  temporality?: string;
  /** Fecha de caducidad calculada para la renovación (MM/DD/YY). */
  expiry?: string;
}

export interface UsersConfig {
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
const SHEET_HEADERS = ["userId", "nombre", "telefono", "menus", "menus_labels", "plan", "plan_status", "pending_plan", "plan_temporality", "plan_expiry", "trial_used"] as const;
type SheetRow = { userId: string; nombre: string; telefono: string; menus: string; menus_labels: string; plan: string; plan_status: string; pending_plan: string; plan_temporality: string; plan_expiry: string; trial_used: string };

/** Índices de columnas (mismo orden que SHEET_HEADERS) para leer sin depender del texto exacto del encabezado. */
const COL_USERID = 0;
const COL_NOMBRE = 1;
const COL_TELEFONO = 2;
const COL_MENUS = 3;
const COL_PLAN = 5;
const COL_PLAN_STATUS = 6;
const COL_PENDING_PLAN = 7;
const COL_PLAN_TEMPORALITY = 8;
const COL_PLAN_EXPIRY = 9;
const COL_TRIAL_USED = 10;

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
export function getStorageBackend(): "sheet" | "file" | "postgres" {
  if (process.env.DATABASE_URL) return "postgres";
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
  backend: "sheet" | "file" | "postgres";
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

export function getSheetAuth(): JWT | null {
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
          temporality: getCol(COL_PLAN_TEMPORALITY) || undefined,
          expiry: getCol(COL_PLAN_EXPIRY) || undefined,
        };
        continue;
      }
      // Usuarios rechazados: guardar su info pero NO darles acceso
      if (planStatus === "rejected") {
        userInfo[uidStr] = {
          name: getCol(COL_NOMBRE) || undefined,
          phone: getCol(COL_TELEFONO) || undefined,
          plan: planName || undefined,
          plan_status: "rejected",
          pending_plan: undefined,
          plan_temporality: undefined,
          plan_expiry: undefined,
          trial_used: getCol(COL_TRIAL_USED) === "true" || undefined,
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
      const pendingPlan = getCol(COL_PENDING_PLAN);
      const planTemporality = getCol(COL_PLAN_TEMPORALITY);
      const planExpiry = getCol(COL_PLAN_EXPIRY);
      userInfo[uidStr] = {
        name: getCol(COL_NOMBRE) || undefined,
        phone: getCol(COL_TELEFONO) || undefined,
        plan: planName || undefined,
        plan_status: planStatus || undefined,
        pending_plan: pendingPlan || undefined,
        plan_temporality: planTemporality || undefined,
        plan_expiry: planExpiry || undefined,
        trial_used: getCol(COL_TRIAL_USED) === "true" || undefined,
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
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresUserSync.js");
    return pg.persistUsersToPG(config);
  }
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
        pending_plan: info?.pending_plan ?? "",
        plan_temporality: info?.plan_temporality ?? "",
        plan_expiry: info?.plan_expiry ?? "",
        trial_used: info?.trial_used ? "true" : "",
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
      pending_plan: "",
      plan_temporality: req.temporality ?? "",
      plan_expiry: req.expiry ?? "",
      trial_used: "",
    }));
    // Usuarios rechazados: se guardan en el sheet para persistir su estado.
    // Se excluyen los que ya re-solicitaron (están en requestedPlans) para evitar duplicados.
    const rejectedRows: SheetRow[] = Object.entries(config.userInfo)
      .filter(([uid, info]) =>
        info.plan_status === "rejected" &&
        !config.allowed.includes(parseInt(uid, 10)) &&
        !config.requestedPlans[uid]
      )
      .map(([uid, info]) => ({
        userId: uid,
        nombre: info.name ?? "",
        telefono: info.phone ?? "",
        menus: "",
        menus_labels: "",
        plan: info.plan ?? "",
        plan_status: "rejected",
        pending_plan: "",
        plan_temporality: "",
        plan_expiry: "",
        trial_used: info.trial_used ? "true" : "",
      }));
    const rows: SheetRow[] = [...allowedRows, ...requestedRows, ...rejectedRows];
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
  const count = config.allowed.length;
  if (process.env.DATABASE_URL) {
    try {
      const pg = await import("./infrastructure/database/PostgresUserSync.js");
      await pg.persistUsersToPG(config);
      return { backend: "postgres" as any, ok: true, count };
    } catch (e) {
      console.error("[user-config] Error PG persist:", e);
      return { backend: "postgres" as any, ok: false, count, error: String(e) };
    }
  }

  const backend = getStorageBackend();
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
  if (process.env.DATABASE_URL) {
    console.log("[user-config] PostgreSQL Backend Activado.");
    const pg = await import("./infrastructure/database/PostgresUserSync.js");
    config = await pg.loadUsersFromPG();
    return;
  }

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

/** Fila de la 2ª pestaña (Estrategias): id, titulo, descripcion, createdBy, price, status (public|private), subscribers. Por defecto status=private y subscribers=0 al crear. */
export interface StrategyRow {
  id: string;
  titulo: string;
  descripcion?: string;
  createdBy?: number;
  price?: string;
  /** En el Sheet se guarda como columna "status"; "private" por defecto al crear. */
  visibility?: string;
  /** Nº de usuarios (distinto al creador) con la estrategia asignada explícitamente. */
  subscribers?: number;
}

const STRATEGIES_SHEET_TITLE = "Estrategias";
/** status = "private" | "public"; subscribers = contador de asignaciones (sin el creador). */
const STRATEGIES_HEADERS = ["id", "titulo", "descripcion", "createdBy", "price", "status", "subscribers"] as const;

/** Carga estrategias desde la 2ª pestaña de la hoja de cálculo. Si no hay Sheet o la pestaña no existe, la crea y devuelve []. */
export async function loadStrategiesFromSheet(): Promise<StrategyRow[]> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresStrategyRepository.js");
    return pg.loadStrategiesFromPG();
  }
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
      const subscribersRaw = values[6]?.trim();
      const subscribers = subscribersRaw ? parseInt(subscribersRaw, 10) : 0;
      result.push({
        id,
        titulo: titulo || id,
        descripcion: desc || undefined,
        createdBy: Number.isNaN(createdBy as number) ? undefined : (createdBy as number),
        price: price || undefined,
        visibility: visibility || undefined,
        subscribers: Number.isNaN(subscribers) ? 0 : subscribers,
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
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresStrategyRepository.js");
    return pg.saveStrategiesToPG(items);
  }
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
        subscribers: String(r.subscribers ?? 0),
      }));
      await sheet.addRows(rows);
    }
    console.log("[user-config] Estrategias: guardadas", items.length, "en 2ª pestaña.");
  } catch (e) {
    console.error("[user-config] Error al guardar estrategias en Sheet:", (e as Error)?.message ?? e);
  }
}

/** Fila de la 3ª pestaña (Planes): id, title, description, price, menuIds + precios por temporalidad. */
export interface PlanRow {
  id: string;
  title: string;
  description: string;
  price: string;
  menuIds: string;
  price_1m: string;
  price_3m: string;
  price_6m: string;
  price_9m: string;
  price_1a: string;
  autoApprove: string;
}

const PLANS_SHEET_TITLE = "Planes";
const PLANS_HEADERS = ["id", "title", "description", "price", "menuIds", "price_1m", "price_3m", "price_6m", "price_9m", "price_1a", "autoApprove"] as const;

/** Carga planes desde la 3ª pestaña. Si no existe, la crea y devuelve []. */
export async function loadPlansFromSheet(): Promise<PlanRow[]> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresPlanRepository.js");
    return pg.loadPlansFromPG();
  }
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
        price_1m: values[5] ?? "",
        price_3m: values[6] ?? "",
        price_6m: values[7] ?? "",
        price_9m: values[8] ?? "",
        price_1a: values[9] ?? "",
        autoApprove: values[10] ?? "",
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
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresPlanRepository.js");
    return pg.savePlansToPG(items);
  }
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
        price_1m: r.price_1m ?? "",
        price_3m: r.price_3m ?? "",
        price_6m: r.price_6m ?? "",
        price_9m: r.price_9m ?? "",
        price_1a: r.price_1a ?? "",
        autoApprove: r.autoApprove ?? "",
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
  if (process.env.DATABASE_URL) {
    try {
      const pg = await import("./infrastructure/database/PostgresUserSync.js");
      const newData = await pg.loadUsersFromPG();
      config.allowed = [...newData.allowed];
      config.menus = { ...newData.menus };
      config.userInfo = { ...newData.userInfo };
      config.requestedPlans = { ...newData.requestedPlans };
      return;
    } catch (e) {
      console.error("[user-config] Error PG Reload", e);
    }
  }

  if (useGoogleSheet()) {
    try {
      const loaded = await loadFromSheet();
      config = loaded;
      lastReloadAt = Date.now();
      const n = Object.keys(config.requestedPlans).length;
      console.log("[user-config] reloadConfigFromStorage: recargado desde Sheet;", n, "solicitudes pendientes.");
    } catch (e) {
      console.error("[user-config] reloadConfigFromStorage: error al recargar desde Sheet:", (e as Error)?.message ?? e);
    }
  } else {
    config = loadFromFile();
    lastReloadAt = Date.now();
    console.log("[user-config] reloadConfigFromStorage: recargado desde archivo;", Object.keys(config.requestedPlans).length, "solicitudes pendientes.");
  }
}

/** TTL del caché en memoria: máximo 3 minutos entre recargas automáticas. */
const CONFIG_CACHE_TTL_MS = 3 * 60 * 1000;
let lastReloadAt = 0;
let refreshInProgress = false;

/**
 * Recarga la config desde el Sheet solo si el caché tiene más de CONFIG_CACHE_TTL_MS.
 * Llamado en el middleware de acceso antes de cada comprobación de permisos.
 * El flag refreshInProgress evita recargas concurrentes si varios usuarios interactúan al mismo tiempo.
 */
export async function refreshIfStale(): Promise<void> {
  if (Date.now() - lastReloadAt < CONFIG_CACHE_TTL_MS) return;
  if (refreshInProgress) return;
  refreshInProgress = true;
  try {
    await reloadConfigFromStorage();
  } finally {
    refreshInProgress = false;
  }
}

/** Devuelve todos los IDs de dueño definidos en BOT_OWNER_ID (puede ser uno o varios separados por coma). */
export function getOwnerIds(): number[] {
  const raw = process.env.BOT_OWNER_ID;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
}

/** Devuelve el primer ID de dueño (o null si no está configurado). Para compatibilidad con usos que requieren un único ID. */
export function getOwnerId(): number | null {
  const ids = getOwnerIds();
  return ids.length > 0 ? ids[0] : null;
}

export function isAllowed(userId: number): boolean {
  const owners = getOwnerIds();
  if (owners.length === 0) return true;
  if (owners.includes(userId)) return true;
  return config.allowed.includes(userId);
}

/** IDs de menús asignados explícitamente al usuario (columna menus). No incluye los del plan. */
export function getUserAssignedMenuIds(userId: number): string[] {
  const list = config.menus[String(userId)];
  return Array.isArray(list) ? [...list] : [];
}

/** Usuarios que tienen el menú asignado explícitamente (columna menus), excluyendo al creador si se indica. */
export function getUsersWithMenu(menuId: string, excludeUserId?: number): number[] {
  return Object.entries(config.menus)
    .filter(([key, ids]) => ids.includes(menuId) && (excludeUserId === undefined || Number(key) !== excludeUserId))
    .map(([key]) => Number(key));
}

/** Quita un menú de la asignación del usuario (solo columna menus). No elimina la estrategia del sistema. */
export async function removeMenuFromUser(userId: number, menuId: string): Promise<PersistResult> {
  const key = String(userId);
  const current = config.menus[key] ?? [];
  if (!current.includes(menuId)) return { backend: getStorageBackend(), ok: true, count: config.allowed.length };
  config.menus[key] = current.filter((m) => m !== menuId);
  const result = await persist();
  if (isCustomMenu(menuId) && userId !== getMenuCreatedBy(menuId)) {
    adjustSubscriberCount(menuId, -1);
  }
  return result;
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

/** Plan pendiente de aprobación. Puede contener "PlanTitle|temporality". */
export function getPendingPlan(userId: number): string | undefined {
  return config.userInfo[String(userId)]?.pending_plan;
}

/** Devuelve solo el nombre del plan pendiente (sin la temporalidad). */
export function getPendingPlanTitle(userId: number): string | undefined {
  const raw = getPendingPlan(userId);
  if (!raw) return undefined;
  return raw.includes("|") ? raw.split("|")[0] : raw;
}

/** Devuelve la temporalidad del plan pendiente (si fue solicitado con una). */
export function getPendingPlanTemporality(userId: number): string | undefined {
  const raw = getPendingPlan(userId);
  if (!raw || !raw.includes("|")) return undefined;
  return raw.split("|")[1];
}

/** Temporalidad del plan activo del usuario. */
export function getPlanTemporality(userId: number): string | undefined {
  return config.userInfo[String(userId)]?.plan_temporality;
}

/** Fecha de caducidad del plan activo (MM/DD/YY) o undefined si no caduca. */
export function getPlanExpiry(userId: number): string | undefined {
  return config.userInfo[String(userId)]?.plan_expiry;
}

/** Parsea una fecha MM/DD/YY a Date. Null si formato inválido. */
function parseMMDDYY(s: string): Date | null {
  const parts = s.split("/");
  if (parts.length !== 3) return null;
  const [mm, dd, yy] = parts;
  const year = 2000 + parseInt(yy ?? "0", 10);
  const month = parseInt(mm ?? "0", 10) - 1;
  const day = parseInt(dd ?? "0", 10);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) return null;
  return new Date(year, month, day);
}

/** Devuelve true si el usuario ya usó el trial (7d) alguna vez.
 * Consulta tanto el config en memoria como el historial en la hoja de Leads.
 */
export async function hasUsedTrial(userId: number): Promise<boolean> {
  // 1. Verificar en memoria (estado actual)
  if (config.userInfo[String(userId)]?.trial_used === true) return true;

  // 2. Verificar en historial de Leads (persistente)
  const leads = await loadLeadsFromSheet();
  const alreadyHadTrial = leads.some(l => 
    String(l.userId) === String(userId) && 
    (l.temporality === "7d" || l.temporality === "1d" || String(l.plan).toLowerCase().includes("trial"))
  );

  return alreadyHadTrial;
}

/** Devuelve true si el plan del usuario ha caducado. Si no tiene fecha de caducidad, no caduca. */
export function isPlanExpired(userId: number): boolean {
  const expiry = config.userInfo[String(userId)]?.plan_expiry;
  if (!expiry) return false;
  const d = parseMMDDYY(expiry);
  if (!d) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d < today;
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

/** Registra solicitud de plan (columnas plan, plan_status=requested, nombre, telefono).
 * Si el usuario ya existe como "rejected" en userInfo, se limpia ese estado para evitar
 * duplicación en el sheet: fluye únicamente por requestedPlans.
 */
export async function addPlanRequest(
  userId: number,
  planName: string,
  opts?: { name?: string; phone?: string; temporality?: string }
): Promise<PersistResult> {
  const key = String(userId);
  // Si estaba rechazado, limpiar el userInfo para que no genere fila duplicada
  if (config.userInfo[key]?.plan_status === "rejected" && !config.allowed.includes(userId)) {
    delete config.userInfo[key];
  }
  const existing = config.requestedPlans[key];
  config.requestedPlans[key] = {
    plan: planName,
    name: opts?.name ?? existing?.name,
    phone: opts?.phone ?? existing?.phone,
    temporality: opts?.temporality ?? existing?.temporality,
  };
  return persist();
}

export interface RequestedPlanUser {
  userId: number;
  plan: string;
  name?: string;
  phone?: string;
  temporality?: string;
  /** true = usuario ya tiene acceso y solicita cambio de plan; false = usuario nuevo sin acceso. */
  isPlanChange: boolean;
}

/** Lista de solicitudes pendientes: usuarios nuevos (requestedPlans) + usuarios con acceso solicitando cambio de plan (pending_plan). */
export function getRequestedPlanUsers(): RequestedPlanUser[] {
  const fromNew: RequestedPlanUser[] = Object.entries(config.requestedPlans).map(([uid, req]) => ({
    userId: parseInt(uid, 10),
    plan: req.plan,
    name: req.name,
    phone: req.phone,
    temporality: req.temporality,
    isPlanChange: false,
  }));
  const fromChange: RequestedPlanUser[] = Object.entries(config.userInfo)
    .filter(([, info]) => !!info.pending_plan)
    .map(([uid, info]) => {
      const raw = info.pending_plan!;
      const [planTitle, temporality] = raw.includes("|")
        ? [raw.split("|")[0]!, raw.split("|")[1]]
        : [raw, undefined];
      return {
        userId: parseInt(uid, 10),
        plan: planTitle,
        name: info.name,
        phone: info.phone,
        temporality,
        isPlanChange: true,
      };
    });
  return [...fromNew, ...fromChange];
}

/**
 * Registra una solicitud de renovación para un usuario que ya tiene o tuvo acceso (caducado).
 * 1. Calcula la nueva fecha de caducidad (sumando a la actual si es futura, o desde hoy).
 * 2. Si es Sheet, busca la fila del usuario y la actualiza (UPSERT).
 * 3. Actualiza la memoria local: quita de allowed y pone en requestedPlans.
 */
export async function requestPlanRenewal(
  userId: number,
  planName: string,
  opts: { name?: string; phone?: string; temporality: string }
): Promise<PersistResult> {
  const key = String(userId);
  const info = config.userInfo[key];
  
  // Calcular base para la nueva fecha
  let baseDate = new Date();
  const currentExpiry = info?.plan_expiry;
  if (currentExpiry) {
    const parsed = parseMMDDYY(currentExpiry);
    // Si la fecha actual de caducidad es futura, sumamos a partir de ella
    if (parsed && parsed > baseDate) baseDate = parsed;
  }
  
  const newExpiryDate = computeExpiryDate(baseDate, opts.temporality);
  const newExpiryStr = formatDateMMDDYY(newExpiryDate);

  // 1. Actualizar memoria local
  // Si estaba en allowed, quitarlo (pasa a ser requested)
  config.allowed = config.allowed.filter(id => id !== userId);
  
  // Registrar en requestedPlans
  config.requestedPlans[key] = {
    plan: planName,
    name: opts.name ?? info?.name,
    phone: opts.phone ?? info?.phone,
    temporality: opts.temporality,
    expiry: newExpiryStr
  };
  
  // Si estaba en userInfo como approved/rejected, limpiar estado para que fluya por requested
  if (config.userInfo[key]) {
    config.userInfo[key] = {
      ...config.userInfo[key],
      plan_status: "requested",
      plan: planName,
      // No tocamos plan_expiry aquí, se usará el de requestedPlans al persistir
    };
  }

  // 2. Persistir (Sheet UPSERT logic if applicable)
  const backend = getStorageBackend();
  if (backend === "sheet") {
    const sheetId = getSheetId();
    const auth = getSheetAuth();
    if (sheetId && auth) {
      try {
        const doc = new GoogleSpreadsheet(sheetId, auth);
        await doc.loadInfo();
        const sheet = doc.sheetsByIndex[0];
        if (sheet) {
          const rows = await sheet.getRows();
          const existing = rows.find(r => String(r.get("userId")) === key);
          
          const rowData = {
            userId: key,
            nombre: opts.name ?? info?.name ?? "",
            telefono: opts.phone ?? info?.phone ?? "",
            plan: planName,
            plan_status: "requested",
            plan_temporality: opts.temporality,
            plan_expiry: newExpiryStr,
            pending_plan: ""
          };

          if (existing) {
            Object.assign(existing, rowData);
            await existing.save();
            console.log(`[user-config] Renewal UPSERT: fila actualizada para ${userId}`);
            return { backend: "sheet", ok: true, count: config.allowed.length };
          }
        }
      } catch (e) {
        console.error("[user-config] requestPlanRenewal Sheet error:", e);
        // Fallback to regular persist if specialized UPSERT fails
      }
    }
  }

  return persist();
}

/** Calcula la fecha de caducidad y la devuelve como "MM/DD/YY". */
function computeExpiryStr(temporality: string): string {
  // Obtener fecha actual en Florida
  const nowStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const d = new Date(nowStr);
  const expiryDate = computeExpiryDate(d, temporality);
  return formatDateMMDDYY(expiryDate);
}

/** Asigna un plan directamente a un usuario (por el dueño). Le da acceso y plan/plan_status=approved. */
export async function assignPlanToUser(
  targetUserId: number,
  planName: string,
  _planMenuIds: string[],
  temporality?: string,
  name?: string,
  phone?: string
): Promise<PersistResult> {
  const key = String(targetUserId);
  if (!config.allowed.includes(targetUserId)) config.allowed.push(targetUserId);
  delete config.requestedPlans[key];
  config.userInfo[key] = {
    ...config.userInfo[key],
    name: name ?? config.userInfo[key]?.name,
    phone: phone ?? config.userInfo[key]?.phone,
    plan: planName,
    plan_status: "approved",
    plan_temporality: temporality || undefined,
    plan_expiry: temporality ? computeExpiryStr(temporality) : undefined,
    trial_used: temporality === "7d" ? true : (config.userInfo[key]?.trial_used ?? undefined),
  };
  return persist();
}

/** Usuario con acceso solicita cambio de plan. Guarda "PlanTitle|temporality" en pending_plan. */
export async function requestPlanChange(userId: number, planName: string, temporality?: string): Promise<PersistResult> {
  const key = String(userId);
  const encoded = temporality ? `${planName}|${temporality}` : planName;
  config.userInfo[key] = { ...config.userInfo[key], pending_plan: encoded };
  return persist();
}

/** Aprueba solicitud de plan. Calcula expiry a partir de la temporalidad almacenada.
 * - Usuario nuevo (en requestedPlans): le da acceso + asigna el plan solicitado.
 * - Usuario con cambio pendiente (pending_plan): actualiza su plan al pending_plan y limpia el campo.
 */
export async function approvePlanRequest(userId: number, _planMenuIds?: string[]): Promise<PersistResult> {
  const key = String(userId);

  // Caso 1: usuario nuevo sin acceso (en requestedPlans)
  const req = config.requestedPlans[key];
  if (req) {
    delete config.requestedPlans[key];
    if (!config.allowed.includes(userId)) config.allowed.push(userId);
    config.userInfo[key] = {
      ...config.userInfo[key],
      name: req.name ?? config.userInfo[key]?.name,
      phone: req.phone ?? config.userInfo[key]?.phone,
      plan: req.plan,
      plan_status: "approved",
      pending_plan: undefined,
      plan_temporality: req.temporality || undefined,
      plan_expiry: req.expiry || (req.temporality ? computeExpiryStr(req.temporality) : undefined),
    };
    return persist();
  }

  // Caso 2: usuario con acceso que solicita cambio de plan (pending_plan = "PlanTitle|temporality")
  const pendingRaw = config.userInfo[key]?.pending_plan;
  if (pendingRaw) {
    const [planTitle, temporality] = pendingRaw.includes("|")
      ? [pendingRaw.split("|")[0]!, pendingRaw.split("|")[1]]
      : [pendingRaw, undefined];
    config.userInfo[key] = {
      ...config.userInfo[key],
      plan: planTitle,
      plan_status: "approved",
      pending_plan: undefined,
      plan_temporality: temporality || undefined,
      plan_expiry: temporality ? computeExpiryStr(temporality) : undefined,
    };
    return persist();
  }

  return { backend: getStorageBackend(), ok: false, count: config.allowed.length, error: "Usuario no tiene solicitud pendiente." };
}

/** Rechaza solicitud de plan. Marca plan_status=rejected y limpia la solicitud pendiente, sin dar acceso al usuario.
 * - Usuario nuevo (en requestedPlans): elimina la solicitud y guarda plan_status=rejected.
 * - Usuario con cambio pendiente (pending_plan): borra el pending_plan y guarda plan_status=rejected.
 */
export async function rejectPlanRequest(userId: number): Promise<PersistResult> {
  const key = String(userId);

  // Caso 1: usuario nuevo sin acceso (en requestedPlans)
  const req = config.requestedPlans[key];
  if (req) {
    delete config.requestedPlans[key];
    // Guardar info del usuario (nombre/teléfono) y marcar como rechazado, sin dar acceso
    config.userInfo[key] = {
      ...config.userInfo[key],
      name: req.name ?? config.userInfo[key]?.name,
      phone: req.phone ?? config.userInfo[key]?.phone,
      plan: req.plan,
      plan_status: "rejected",
      pending_plan: undefined,
    };
    return persist();
  }

  // Caso 2: usuario con acceso que solicita cambio de plan (pending_plan)
  const pendingRaw = config.userInfo[key]?.pending_plan;
  if (pendingRaw) {
    config.userInfo[key] = {
      ...config.userInfo[key],
      pending_plan: undefined,
      plan_status: "rejected",
    };
    return persist();
  }

  return { backend: getStorageBackend(), ok: false, count: config.allowed.length, error: "Usuario no tiene solicitud pendiente." };
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
  if (isCustomMenu(menuId) && userId !== getMenuCreatedBy(menuId)) {
    adjustSubscriberCount(menuId, has ? -1 : 1);
  }
  return !has;
}

/** Quita un menú de todos los usuarios (p. ej. al eliminar el menú). */
export async function removeMenuFromAllUsers(menuId: string): Promise<void> {
  const createdBy = isCustomMenu(menuId) ? getMenuCreatedBy(menuId) : undefined;
  let changed = false;
  let nonCreatorRemoved = 0;
  for (const key of Object.keys(config.menus)) {
    const before = config.menus[key].length;
    config.menus[key] = config.menus[key].filter((m) => m !== menuId);
    if (config.menus[key].length !== before) {
      changed = true;
      if (createdBy === undefined || Number(key) !== createdBy) nonCreatorRemoved++;
    }
  }
  if (changed) {
    await persist();
    if (isCustomMenu(menuId) && nonCreatorRemoved > 0) {
      adjustSubscriberCount(menuId, -nonCreatorRemoved);
    }
  }
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

/** Carga solicitudes (desde PG si aplica, si no desde Sheet/archivo). */
export async function getStrategyRequests(): Promise<StrategyRequest[]> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresStrategyRequestRepository.js");
    return pg.loadStrategyRequestsFromPG();
  }
  if (useGoogleSheet()) return loadStrategyRequestsFromSheet();
  return loadStrategyRequestsSync();
}

/** Añade una solicitud de estrategia (evita duplicados userId+menuId). */
export async function addStrategyRequest(userId: number, menuId: string): Promise<boolean> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresStrategyRequestRepository.js");
    return pg.addStrategyRequestToPG(userId, menuId);
  }
  const list = useGoogleSheet() ? await loadStrategyRequestsFromSheet() : loadStrategyRequestsSync();
  if (list.some((r) => r.userId === userId && r.menuId === menuId)) return false;
  list.push({ userId, menuId, requestedAt: Date.now() });
  if (useGoogleSheet()) await saveStrategyRequestsToSheet(list);
  else saveStrategyRequestsSync(list);
  return true;
}

/** Elimina una solicitud (al aprobar o rechazar). */
export async function removeStrategyRequest(userId: number, menuId: string): Promise<boolean> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresStrategyRequestRepository.js");
    return pg.removeStrategyRequestFromPG(userId, menuId);
  }
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
  const owners = getOwnerIds();
  return owners.length > 0 && owners.includes(userId);
}

const TESTING_SHEET_INDEX = 4;
const TESTING_HEADERS = ["userId", "cutoff_date"] as const;

/**
 * Guarda (o elimina) la fecha de corte en la pestaña "Testing" para un userId específico.
 * La pestaña tiene cabeceras ["userId","cutoff_date"] con una fila por admin.
 * Pasa null para eliminar la entrada del userId (sin corte = base completa).
 */
export async function saveTestingCutoffDate(date: string | null, userId: number): Promise<void> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresTestingConfigRepository.js");
    return pg.saveTestingCutoffDatePG(date, userId);
  }
  const sheetId = getSheetId();
  if (!sheetId) return;
  const auth = getSheetAuth();
  if (!auth) return;
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByIndex[TESTING_SHEET_INDEX];
    if (!sheet) {
      sheet = await doc.addSheet({
        title: "Testing",
        headerValues: [...TESTING_HEADERS],
      });
      console.log("[user-config] Testing: pestaña 'Testing' creada con cabeceras por usuario (5ª pestaña).");
    } else {
      try {
        await sheet.loadHeaderRow(1);
      } catch {
        await sheet.setHeaderRow([...TESTING_HEADERS], 1);
      }
    }
    const rows = await sheet.getRows();
    const existing = rows.find((r) => String(r.get("userId")).trim() === String(userId));
    if (date === null) {
      if (existing) {
        await existing.delete();
        console.log(`[user-config] Testing: fecha eliminada para userId=${userId}.`);
      }
    } else {
      if (existing) {
        existing.set("cutoff_date", date);
        await existing.save();
        console.log(`[user-config] Testing: fecha actualizada → ${date} para userId=${userId}.`);
      } else {
        await sheet.addRow({ userId: String(userId), cutoff_date: date });
        console.log(`[user-config] Testing: fecha creada → ${date} para userId=${userId}.`);
      }
    }
  } catch (e) {
    console.error("[user-config] Error al guardar fecha de testing en Sheet:", (e as Error)?.message ?? e);
    throw e;
  }
}

/**
 * Lee la fecha de corte de un userId específico desde la pestaña "Testing" (5ª pestaña).
 * - Si el usuario no tiene fila o la pestaña no existe → retorna null (base completa).
 * - Si tiene una fecha válida MM/DD/YY → la retorna para filtrar el mapa.
 */
export async function loadTestingCutoffDate(userId: number): Promise<string | null> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresTestingConfigRepository.js");
    return pg.loadTestingCutoffDatePG(userId);
  }
  const sheetId = getSheetId();
  if (!sheetId) return null;
  const auth = getSheetAuth();
  if (!auth) return null;
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[TESTING_SHEET_INDEX];
    if (!sheet) return null;
    try {
      await sheet.loadHeaderRow(1);
    } catch {
      return null;
    }
    const rows = await sheet.getRows();
    const row = rows.find((r) => String(r.get("userId")).trim() === String(userId));
    if (!row) return null;
    const raw = String(row.get("cutoff_date") ?? "").trim();
    if (!raw) return null;
    if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(raw)) return raw;
    console.warn(`[user-config] Testing: cutoff_date inválido para userId=${userId}:`, raw);
    return null;
  } catch (e) {
    console.error("[user-config] Error al leer fecha de testing desde Sheet:", (e as Error)?.message ?? e);
    return null;
  }
}

// ─── Sugerencia ─────────────────────────────────────────────────────────────────

/** Fila de la 6ª pestaña (Sugerencia): userId, nombre, telefono, texto, fecha. */
export interface SugerenciaRow {
  userId: number;
  nombre: string;
  telefono: string;
  texto: string;
  /** Fecha en formato DD/MM/YYYY HH:MM (hora Florida). */
  fecha: string;
}

const SUGERENCIA_SHEET_TITLE = "Sugerencia";
const SUGERENCIA_HEADERS = ["userId", "nombre", "telefono", "texto", "fecha"] as const;
export const SUGERENCIA_SHEET_INDEX = 5;

/**
 * Carga todas las sugerencias desde la 6ª pestaña del Sheet.
 * Si la pestaña no existe, la crea y devuelve [].
 */
export async function loadSugerenciaFromSheet(): Promise<SugerenciaRow[]> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresSugerenciaRepository.js");
    return pg.loadSugerenciasFromPG();
  }
  const sheetId = getSheetId();
  if (!sheetId) return [];
  const auth = getSheetAuth();
  if (!auth) return [];
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByIndex[SUGERENCIA_SHEET_INDEX];
    if (!sheet) {
      await doc.addSheet({
        title: SUGERENCIA_SHEET_TITLE,
        headerValues: [...SUGERENCIA_HEADERS],
      });
      console.log("[sugerencia] Pestaña 'Sugerencia' creada (6ª pestaña).");
      return [];
    }
    try {
      await sheet.loadHeaderRow(1);
    } catch {
      await sheet.setHeaderRow([...SUGERENCIA_HEADERS], 1);
      return [];
    }
    const rows = await sheet.getRows({ offset: 0, limit: 10000 });
    const headers = sheet.headerValues;
    const result: SugerenciaRow[] = [];
    for (const row of rows) {
      const obj = row.toObject() as Record<string, unknown>;
      const values = headers.map((h) => (h ? String(obj[h] ?? "").trim() : ""));
      const userIdStr = values[0] ?? "";
      const uid = parseInt(userIdStr, 10);
      if (!userIdStr || Number.isNaN(uid)) continue;
      result.push({
        userId: uid,
        nombre: values[1] ?? "",
        telefono: values[2] ?? "",
        texto: values[3] ?? "",
        fecha: values[4] ?? "",
      });
    }
    console.log("[sugerencia] Cargados", result.length, "sugerencias desde la 6ª pestaña.");
    return result;
  } catch (e) {
    console.error("[sugerencia] Error al cargar sugerencias desde Sheet:", (e as Error)?.message ?? e);
    return [];
  }
}

/**
 * Añade una sola fila de sugerencia a la 6ª pestaña (sin clearRows, preserva historial).
 * Crea la pestaña si no existe.
 */
export async function appendSugerenciaToSheet(row: SugerenciaRow): Promise<void> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresSugerenciaRepository.js");
    return pg.appendSugerenciaToPG(row);
  }
  const sheetId = getSheetId();
  if (!sheetId) return;
  const auth = getSheetAuth();
  if (!auth) return;
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByIndex[SUGERENCIA_SHEET_INDEX];
    if (!sheet) {
      sheet = await doc.addSheet({
        title: SUGERENCIA_SHEET_TITLE,
        headerValues: [...SUGERENCIA_HEADERS],
      });
      console.log("[sugerencia] Pestaña 'Sugerencia' creada al guardar primera fila.");
    } else {
      try {
        await sheet.loadHeaderRow(1);
      } catch {
        await sheet.setHeaderRow([...SUGERENCIA_HEADERS], 1);
      }
    }
    await sheet.addRow({
      userId: String(row.userId),
      nombre: row.nombre,
      telefono: row.telefono,
      texto: row.texto,
      fecha: row.fecha,
    });
    console.log("[sugerencia] Sugerencia guardado para userId=", row.userId);
  } catch (e) {
    console.error("[sugerencia] Error al guardar sugerencia en Sheet:", (e as Error)?.message ?? e);
    throw e;
  }
}

/** Devuelve todas las sugerencias de un usuario específico, ordenados por fecha (más reciente primero). */
export async function getSugerenciaForUser(userId: number): Promise<SugerenciaRow[]> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresSugerenciaRepository.js");
    return pg.getSugerenciaForUserPG(userId);
  }
  const all = await loadSugerenciaFromSheet();
  return all.filter((r) => r.userId === userId).reverse();
}

// ─── Announcements ────────────────────────────────────────────────────────────

/** Fila de la 7ª pestaña (Announcements): id, texto, fecha. */
export interface AnnouncementRow {
  /** UUID simple (timestamp ms) que sirve como clave para editar/eliminar. */
  id: string;
  texto: string;
  /** Fecha en formato DD/MM/YYYY HH:MM (hora Florida). */
  fecha: string;
}

const ANNOUNCEMENTS_SHEET_TITLE = "Announcements";
const ANNOUNCEMENTS_HEADERS = ["id", "texto", "fecha"] as const;
export const ANNOUNCEMENTS_SHEET_INDEX = 6;

/** TTL del caché de anuncios (2 min) para evitar leer el Sheet en cada interacción. */
const ANNOUNCEMENTS_CACHE_TTL_MS = 2 * 60 * 1000;
let announcementsCache: { at: number; items: AnnouncementRow[] } | null = null;

/** Invalida la caché de anuncios para que la próxima lectura vaya al Sheet. */
export function invalidateAnnouncementsCache(): void {
  announcementsCache = null;
}

/**
 * Carga todos los anuncios desde la 7ª pestaña del Sheet.
 * Usa caché de 2 minutos para no leer el Sheet en cada interacción de usuario.
 * Crea la pestaña si no existe.
 */
export async function loadAnnouncementsFromSheet(forceRefresh = false): Promise<AnnouncementRow[]> {
  if (process.env.DATABASE_URL) {
    if (!forceRefresh && announcementsCache && Date.now() - announcementsCache.at < ANNOUNCEMENTS_CACHE_TTL_MS) {
      return announcementsCache.items;
    }
    const pg = await import("./infrastructure/database/PostgresAnnouncementRepository.js");
    const items = await pg.loadAnnouncementsFromPG();
    announcementsCache = { at: Date.now(), items };
    return items;
  }
  if (!forceRefresh && announcementsCache && Date.now() - announcementsCache.at < ANNOUNCEMENTS_CACHE_TTL_MS) {
    return announcementsCache.items;
  }
  const sheetId = getSheetId();
  if (!sheetId) return [];
  const auth = getSheetAuth();
  if (!auth) return [];
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByIndex[ANNOUNCEMENTS_SHEET_INDEX];
    if (!sheet) {
      await doc.addSheet({
        title: ANNOUNCEMENTS_SHEET_TITLE,
        headerValues: [...ANNOUNCEMENTS_HEADERS],
      });
      console.log("[announcements] Pestaña 'Announcements' creada (7ª pestaña).");
      announcementsCache = { at: Date.now(), items: [] };
      return [];
    }
    try {
      await sheet.loadHeaderRow(1);
    } catch {
      await sheet.setHeaderRow([...ANNOUNCEMENTS_HEADERS], 1);
      announcementsCache = { at: Date.now(), items: [] };
      return [];
    }
    const rows = await sheet.getRows({ offset: 0, limit: 500 });
    const headers = sheet.headerValues;
    const result: AnnouncementRow[] = [];
    for (const row of rows) {
      const obj = row.toObject() as Record<string, unknown>;
      const values = headers.map((h) => (h ? String(obj[h] ?? "").trim() : ""));
      const id = values[0] ?? "";
      const texto = values[1] ?? "";
      if (!id || !texto) continue;
      result.push({ id, texto, fecha: values[2] ?? "" });
    }
    console.log("[announcements] Cargados", result.length, "anuncios desde la 7ª pestaña.");
    announcementsCache = { at: Date.now(), items: result };
    return result;
  } catch (e) {
    console.error("[announcements] Error al cargar desde Sheet:", (e as Error)?.message ?? e);
    return announcementsCache?.items ?? [];
  }
}

/** Persiste la lista completa de anuncios en la 7ª pestaña (reemplaza todo). Crea la pestaña si no existe. */
export async function saveAnnouncementsToSheet(items: AnnouncementRow[]): Promise<void> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresAnnouncementRepository.js");
    await pg.saveAnnouncementsToPG(items);
    announcementsCache = { at: Date.now(), items };
    return;
  }
  const sheetId = getSheetId();
  if (!sheetId) return;
  const auth = getSheetAuth();
  if (!auth) return;
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByIndex[ANNOUNCEMENTS_SHEET_INDEX];
    if (!sheet) {
      sheet = await doc.addSheet({
        title: ANNOUNCEMENTS_SHEET_TITLE,
        headerValues: [...ANNOUNCEMENTS_HEADERS],
      });
    } else {
      await sheet.setHeaderRow([...ANNOUNCEMENTS_HEADERS], 1);
      await sheet.clearRows();
    }
    if (items.length > 0) {
      await sheet.addRows(items.map((r) => ({ id: r.id, texto: r.texto, fecha: r.fecha })));
    }
    announcementsCache = { at: Date.now(), items };
    console.log("[announcements] Guardados", items.length, "anuncios.");
  } catch (e) {
    console.error("[announcements] Error al guardar en Sheet:", (e as Error)?.message ?? e);
    throw e;
  }
}

/** Añade un nuevo anuncio. Devuelve la lista actualizada. */
export async function addAnnouncement(texto: string, fecha: string): Promise<AnnouncementRow[]> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresAnnouncementRepository.js");
    const items = await pg.addAnnouncementToPG(texto, fecha);
    announcementsCache = { at: Date.now(), items };
    return items;
  }
  const items = await loadAnnouncementsFromSheet(true);
  const newItem: AnnouncementRow = { id: String(Date.now()), texto, fecha };
  const updated = [...items, newItem];
  await saveAnnouncementsToSheet(updated);
  return updated;
}

/** Edita el texto de un anuncio por id. Devuelve la lista actualizada o null si no se encontró. */
export async function editAnnouncement(id: string, newTexto: string): Promise<AnnouncementRow[] | null> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresAnnouncementRepository.js");
    const items = await pg.editAnnouncementInPG(id, newTexto);
    if (items) announcementsCache = { at: Date.now(), items };
    return items;
  }
  const items = await loadAnnouncementsFromSheet(true);
  const idx = items.findIndex((r) => r.id === id);
  if (idx < 0) return null;
  items[idx] = { ...items[idx]!, texto: newTexto };
  await saveAnnouncementsToSheet(items);
  return items;
}

/** Elimina un anuncio por id. Devuelve la lista actualizada o null si no se encontró. */
export async function deleteAnnouncement(id: string): Promise<AnnouncementRow[] | null> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresAnnouncementRepository.js");
    const items = await pg.deleteAnnouncementFromPG(id);
    if (items) announcementsCache = { at: Date.now(), items };
    return items;
  }
  const items = await loadAnnouncementsFromSheet(true);
  const next = items.filter((r) => r.id !== id);
  if (next.length === items.length) return null;
  await saveAnnouncementsToSheet(next);
  return next;
}

/** Elimina todos los anuncios de una vez. */
export async function clearAllAnnouncements(): Promise<void> {
  await saveAnnouncementsToSheet([]);
}

// ─── Leads ────────────────────────────────────────────────────────────────────

/** Fila de la 8ª pestaña (Leads): registro permanente de prospectos. */
export interface LeadRow {
  userId: string;
  nombre: string;
  telefono: string;
  plan: string;
  temporality: string;
  /** Fecha en formato DD/MM/YYYY HH:MM (hora Florida). */
  fecha: string;
  /** trial_active | trial_expired | converted | lost */
  status: string;
}

const LEADS_SHEET_TITLE = "Leads";
const LEADS_HEADERS = ["userId", "nombre", "telefono", "plan", "temporality", "fecha", "status"] as const;

/** Formatea la fecha actual en zona horaria de Florida (America/New_York). */
function floridaNow(): string {
  return new Date().toLocaleString("es-ES", {
    timeZone: "America/New_York",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).replace(",", "");
}

/**
 * Guarda un lead (append-only) en la 8ª pestaña del Sheet.
 * Crea la pestaña si no existe. Nunca borra filas existentes.
 */
export async function saveLead(
  userId: number,
  name: string,
  phone: string,
  plan: string,
  temporality: string,
  status = "trial_active"
): Promise<void> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresLeadRepository.js");
    return pg.saveLeadToPG(userId, name, phone, plan, temporality, status);
  }
  const sheetId = getSheetId();
  if (!sheetId) {
    console.log("[leads] Sheet no configurado; lead no guardado para userId=", userId);
    return;
  }
  const auth = getSheetAuth();
  if (!auth) return;
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByTitle[LEADS_SHEET_TITLE];
    if (!sheet) {
      sheet = await doc.addSheet({
        title: LEADS_SHEET_TITLE,
        headerValues: [...LEADS_HEADERS],
      });
      console.log("[leads] Pestaña 'Leads' creada exitosamente.");
    } else {
      try {
        await sheet.loadHeaderRow(1);
      } catch {
        await sheet.setHeaderRow([...LEADS_HEADERS], 1);
      }
    }

    // --- Lógica UPSERT (Bliss Protocol) ---
    const rows = await sheet.getRows();
    const existingRow = rows.find(r => String(r.get("userId")) === String(userId));

    const leadData = {
      userId: String(userId),
      nombre: name,
      telefono: phone,
      plan,
      temporality,
      fecha: floridaNow(),
      status,
    };

    if (existingRow) {
      // Actualizar fila existente
      Object.assign(existingRow, leadData);
      await existingRow.save();
      console.log("[leads] Lead actualizado (UPSERT): userId=", userId);
    } else {
      // Crear nueva fila
      await sheet.addRow(leadData);
      console.log("[leads] Lead nuevo guardado: userId=", userId);
    }
  } catch (e) {
    console.error("[leads] Error al guardar lead en Sheet:", (e as Error)?.message ?? e);
  }
}

/** Carga todos los leads desde la 8ª pestaña. Crea la pestaña si no existe. */
export async function loadLeadsFromSheet(): Promise<LeadRow[]> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresLeadRepository.js");
    return pg.loadLeadsFromPG();
  }
  const sheetId = getSheetId();
  if (!sheetId) return [];
  const auth = getSheetAuth();
  if (!auth) return [];
  try {
    const doc = new GoogleSpreadsheet(sheetId, auth);
    await doc.loadInfo();
    let sheet = doc.sheetsByTitle[LEADS_SHEET_TITLE];
    if (!sheet) {
      await doc.addSheet({
        title: LEADS_SHEET_TITLE,
        headerValues: [...LEADS_HEADERS],
      });
      console.log("[leads] Pestaña 'Leads' creada exitosamente.");
      return [];
    }
    try {
      await sheet.loadHeaderRow(1);
    } catch {
      await sheet.setHeaderRow([...LEADS_HEADERS], 1);
      return [];
    }
    const rows = await sheet.getRows({ offset: 0, limit: 10000 });
    const headers = sheet.headerValues;
    const result: LeadRow[] = [];
    for (const row of rows) {
      const obj = row.toObject() as Record<string, unknown>;
      const values = headers.map((h) => (h ? String(obj[h] ?? "").trim() : ""));
      const userIdStr = values[0] ?? "";
      if (!userIdStr) continue;
      result.push({
        userId: userIdStr,
        nombre: values[1] ?? "",
        telefono: values[2] ?? "",
        plan: values[3] ?? "",
        temporality: values[4] ?? "",
        fecha: values[5] ?? "",
        status: values[6] ?? "",
      });
    }
    console.log("[leads] Cargados", result.length, "leads desde la 8ª pestaña.");
    return result;
  } catch (e) {
    console.error("[leads] Error al cargar leads desde Sheet:", (e as Error)?.message ?? e);
    return [];
  }
}

/** Cuenta total de leads registrados. */
export async function getLeadCount(): Promise<number> {
  if (process.env.DATABASE_URL) {
    const pg = await import("./infrastructure/database/PostgresLeadRepository.js");
    const leads = await pg.loadLeadsFromPG();
    return leads.length;
  }
  const leads = await loadLeadsFromSheet();
  return leads.length;
}

/** Sistema de Referidos: Renueva el plan sumando 1 mes para recompensar. */
export async function extendPlanByOneMonth(userId: number): Promise<void> {
  const key = String(userId);
  const info = config.userInfo[key];
  if (!info) return;

  if (!info.plan_expiry) {
    info.plan_expiry = computeExpiryStr("1mes"); 
  } else {
    try {
      const parts = info.plan_expiry.split("/");
      if (parts.length === 3) {
        const m = Number(parts[0]);
        const d = Number(parts[1]);
        const y = Number(`20${parts[2]}`);
        
        const currentDate = new Date(y, m - 1, d);
        currentDate.setMonth(currentDate.getMonth() + 1);
        
        const endM = String(currentDate.getMonth() + 1).padStart(2, "0");
        const endD = String(currentDate.getDate()).padStart(2, "0");
        const endY = String(currentDate.getFullYear()).slice(-2);
        info.plan_expiry = `${endM}/${endD}/${endY}`;
      } else {
        info.plan_expiry = computeExpiryStr("1mes"); // Fallback
      }
    } catch (e) {
      info.plan_expiry = computeExpiryStr("1mes");
    }
  }
  
  await persist();
}
