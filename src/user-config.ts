/**
 * Whitelist y menús extra por usuario.
 * Persistencia: Google Sheet (si GOOGLE_SHEET_ID + credenciales) o JSON en data/bot-users.json.
 * BOT_OWNER_ID = único administrador; solo usuarios en allowed pueden usar el bot.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const CONFIG_DIR = path.join(process.cwd(), "data");
const CONFIG_PATH = path.join(CONFIG_DIR, "bot-users.json");

export interface UserInfo {
  name?: string;
  phone?: string;
  plan?: string;
  plan_status?: string;
}

/** Usuarios que solicitaron un plan pero aún no están aprobados (no están en allowed). */
export interface PlanRequest {
  plan: string;
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

const SHEET_HEADERS = ["userId", "nombre", "telefono", "menus", "plan", "plan_status"] as const;
type SheetRow = { userId: string; nombre: string; telefono: string; menus: string; plan: string; plan_status: string };

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
    const rows = await sheet.getRows<SheetRow & { est_grupos?: string; est_individuales?: string }>({ offset: 0 });
    const allowed: number[] = [];
    const menus: Record<string, string[]> = {};
    const userInfo: Record<string, UserInfo> = {};
    const requestedPlans: Record<string, PlanRequest> = {};
    for (const row of rows) {
      const uidStr = String(row.get("userId") ?? "").trim();
      const uid = parseInt(uidStr, 10);
      if (uidStr === "" || Number.isNaN(uid)) continue;
      const planStatus = String(row.get("plan_status") ?? "").trim().toLowerCase();
      const planName = String(row.get("plan") ?? "").trim();
      if (planStatus === "requested") {
        requestedPlans[uidStr] = { plan: planName || "—" };
        continue;
      }
      allowed.push(uid);
      let menuIds: string[] = [];
      const menusStr = String(row.get("menus") ?? "").trim();
      if (menusStr) menuIds = menusStr.split(",").map((s) => s.trim()).filter(Boolean);
      else {
        const g = String(row.get("est_grupos") ?? "").trim();
        const i = String(row.get("est_individuales") ?? "").trim();
        if (g === "1" || g.toLowerCase() === "true") menuIds.push("est_grupos");
        if (i === "1" || i.toLowerCase() === "true") menuIds.push("est_individuales");
      }
      menus[uidStr] = menuIds;
      const nombre = String(row.get("nombre") ?? "").trim();
      const telefono = String(row.get("telefono") ?? "").trim();
      userInfo[uidStr] = {
        name: nombre || undefined,
        phone: telefono || undefined,
        plan: planName || undefined,
        plan_status: planStatus || undefined,
      };
    }
    console.log("[user-config] Google Sheet: cargados", allowed.length, "usuarios;", Object.keys(requestedPlans).length, "solicitudes pendientes.");
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
      return {
        allowed: Array.isArray(data.allowed) ? data.allowed : [],
        menus: data.menus && typeof data.menus === "object" ? data.menus : {},
        userInfo: data.userInfo && typeof data.userInfo === "object" ? data.userInfo : {},
        requestedPlans: data.requestedPlans && typeof data.requestedPlans === "object" ? data.requestedPlans : {},
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
  console.log("[user-config] Google Sheet: guardando", config.allowed.length, "usuarios…");
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
      return {
        userId: key,
        nombre: info?.name ?? "",
        telefono: info?.phone ?? "",
        menus: menuIds.join(","),
        plan: info?.plan ?? "",
        plan_status: info?.plan_status ?? "approved",
      };
    });
    const requestedRows: SheetRow[] = Object.entries(config.requestedPlans).map(([uid, req]) => ({
      userId: uid,
      nombre: "",
      telefono: "",
      menus: "",
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
      console.log("[user-config] Google Sheet: guardados", rows.length, "usuarios.");
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

export function getExtraMenus(userId: number): string[] {
  const list = config.menus[String(userId)];
  return Array.isArray(list) ? [...list] : [];
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

/** Registra solicitud de plan (columna E=plan, F=requested). Si usa Sheet, añade/actualiza la fila del userId. */
export async function addPlanRequest(userId: number, planName: string): Promise<PersistResult> {
  const key = String(userId);
  config.requestedPlans[key] = { plan: planName };
  return persist();
}

/** Lista de usuarios con plan_status "requested" (pendientes de aprobación). */
export function getRequestedPlanUsers(): { userId: number; plan: string }[] {
  return Object.entries(config.requestedPlans).map(([uid, req]) => ({
    userId: parseInt(uid, 10),
    plan: req.plan,
  }));
}

/** Aprueba solicitud: quita de requestedPlans, añade a allowed, asigna menús del plan (si se pasan) y guarda plan/plan_status=approved. */
export async function approvePlanRequest(userId: number, planMenuIds?: string[]): Promise<PersistResult> {
  const key = String(userId);
  const req = config.requestedPlans[key];
  if (!req) {
    return { backend: getStorageBackend(), ok: false, count: config.allowed.length, error: "Usuario no está en solicitudes pendientes." };
  }
  delete config.requestedPlans[key];
  if (!config.allowed.includes(userId)) config.allowed.push(userId);
  config.userInfo[key] = { ...config.userInfo[key], plan: req.plan, plan_status: "approved" };
  if (Array.isArray(planMenuIds)) config.menus[key] = [...planMenuIds];
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

export function isOwner(userId: number): boolean {
  const owner = getOwnerId();
  return owner !== null && userId === owner;
}
