/**
 * Whitelist y menús extra por usuario.
 * Persistencia: PostgreSQL (DATABASE_URL) o JSON en data/bot-users.json.
 * BOT_OWNER_ID = único administrador; solo usuarios en allowed pueden usar el bot.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * NOTA: Google Sheets ha sido eliminado como backend de persistencia.
 * PostgreSQL es la ÚNICA fuente de verdad para datos en producción.
 * ────────────────────────────────────────────────────────────────────────────
 */

import { getPlanByTitle, computeExpiryDate, formatDateMMDDYY } from "./plans.js";
import { isCustomMenu, adjustSubscriberCount, getMenuCreatedBy } from "./custom-menus.js";

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

/** Resolver para obtener el texto (label) de un menú por ID. Se asigna desde bot al arranque (getExtraMenuLabel). */
let sheetMenuLabelResolver: ((menuId: string) => string | undefined) | null = null;
export function setSheetMenuLabelResolver(fn: (menuId: string) => string | undefined): void {
  sheetMenuLabelResolver = fn;
}

export function getStorageBackend(): "postgres" {
  return "postgres";
}

/** Resultado de persist(): para mostrar en la respuesta al agregar acceso. */
export interface PersistResult {
  backend: "postgres";
  ok: boolean;
  count: number;
  error?: string;
}

// ─── Persist ─────────────────────────────────────────────────────────────────

async function persist(): Promise<PersistResult> {
  const count = config.allowed.length;
  if (!process.env.DATABASE_URL) {
    console.error("❌ CRÍTICO: DATABASE_URL no definida. Imposible persistir configuración.");
    return { backend: "postgres", ok: false, count, error: "Missing DATABASE_URL" };
  }
  try {
    const pg = await import("./infrastructure/database/PostgresUserSync.js");
    await pg.persistUsersToPG(config);
    return { backend: "postgres", ok: true, count };
  } catch (e) {
    console.error("[user-config] Error PG persist:", e);
    return { backend: "postgres", ok: false, count, error: String(e) };
  }
}

// ─── Init ────────────────────────────────────────────────────────────────────

/** Carga la config desde PG. Llamar al arranque del bot. */
export async function initUserConfig(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("❌ CRÍTICO: DATABASE_URL no definida. El bot requiere PostgreSQL para funcionar.");
    process.exit(1);
  }
  console.log("[user-config] PostgreSQL Backend Activado.");
  const pg = await import("./infrastructure/database/PostgresUserSync.js");
  config = await pg.loadUsersFromPG();
}

// ─── Strategies ──────────────────────────────────────────────────────────────

export interface StrategyRow {
  id: string;
  titulo: string;
  descripcion?: string;
  createdBy?: number;
  price?: string;
  visibility?: string;
  subscribers?: number;
}

export async function loadStrategiesFromDB(): Promise<StrategyRow[]> {
  const pg = await import("./infrastructure/database/PostgresStrategyRepository.js");
  return pg.loadStrategiesFromPG();
}

export async function saveStrategiesToDB(items: StrategyRow[]): Promise<void> {
  const pg = await import("./infrastructure/database/PostgresStrategyRepository.js");
  return pg.saveStrategiesToPG(items);
}

// ─── Plans ───────────────────────────────────────────────────────────────────

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

export async function loadPlansFromDB(): Promise<PlanRow[]> {
  const pg = await import("./infrastructure/database/PostgresPlanRepository.js");
  return pg.loadPlansFromPG();
}

export async function savePlansToDB(items: PlanRow[]): Promise<void> {
  const pg = await import("./infrastructure/database/PostgresPlanRepository.js");
  return pg.savePlansToPG(items);
}

// ─── Reload / Refresh ────────────────────────────────────────────────────────

/** Recarga la config desde PG y reemplaza la en memoria. */
export async function reloadConfigFromStorage(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("❌ CRÍTICO: DATABASE_URL no definida. Imposible recargar configuración.");
    return;
  }
  try {
    const pg = await import("./infrastructure/database/PostgresUserSync.js");
    const newData = await pg.loadUsersFromPG();
    config.allowed = [...newData.allowed];
    config.menus = { ...newData.menus };
    config.userInfo = { ...newData.userInfo };
    config.requestedPlans = { ...newData.requestedPlans };
    lastReloadAt = Date.now();
  } catch (e) {
    console.error("[user-config] Error PG Reload", e);
  }
}

/** TTL del caché en memoria: máximo 3 minutos entre recargas automáticas. */
const CONFIG_CACHE_TTL_MS = 3 * 60 * 1000;
let lastReloadAt = 0;
let refreshInProgress = false;

/**
 * Recarga la config desde PG solo si el caché tiene más de CONFIG_CACHE_TTL_MS.
 * Llamado en el middleware de acceso antes de cada comprobación de permisos.
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

// ─── Getters / Setters (lógica de negocio) ───────────────────────────────────

/** Devuelve todos los IDs de dueño definidos en BOT_OWNER_ID (puede ser uno o varios separados por coma). */
export function getOwnerIds(): number[] {
  const raw = process.env.BOT_OWNER_ID;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !Number.isNaN(n));
}

/** Devuelve sólo el primer dueño (para retrocompatibilidad). */
export function getOwnerId(): number | null {
  const ids = getOwnerIds();
  return ids.length > 0 ? ids[0]! : null;
}

export function isAllowed(userId: number): boolean {
  if (getOwnerIds().includes(userId)) return true;
  return config.allowed.includes(userId);
}

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
export function parseMMDDYY(s: string): Date | null {
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
 * Consulta tanto el config en memoria como el historial en Leads.
 */
export async function hasUsedTrial(userId: number): Promise<boolean> {
  // 1. Verificar en memoria (estado actual)
  if (config.userInfo[String(userId)]?.trial_used === true) return true;

  // 2. Verificar en historial de Leads (persistente)
  const leads = await loadLeadsFromDB();
  const alreadyHadTrial = leads.some((l: any) =>
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
 * duplicación: fluye únicamente por requestedPlans.
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
 * 2. Actualiza la memoria local: quita de allowed y pone en requestedPlans.
 * 3. Persiste a PostgreSQL.
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
    if (parsed && parsed > baseDate) baseDate = parsed;
  }

  const newExpiryDate = computeExpiryDate(baseDate, opts.temporality);
  const newExpiryStr = formatDateMMDDYY(newExpiryDate);

  // Actualizar memoria local
  config.allowed = config.allowed.filter(id => id !== userId);

  config.requestedPlans[key] = {
    plan: planName,
    name: opts.name ?? info?.name,
    phone: opts.phone ?? info?.phone,
    temporality: opts.temporality,
    expiry: newExpiryStr
  };

  if (config.userInfo[key]) {
    config.userInfo[key] = {
      ...config.userInfo[key],
      plan_status: "requested",
      plan: planName,
    };
  }

  return persist();
}

/** Calcula la fecha de caducidad y la devuelve como "MM/DD/YY". */
function computeExpiryStr(temporality: string): string {
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

/** Aprueba solicitud de plan. */
export async function approvePlanRequest(userId: number, _planMenuIds?: string[]): Promise<PersistResult> {
  const key = String(userId);

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

/** Rechaza solicitud de plan. */
export async function rejectPlanRequest(userId: number): Promise<PersistResult> {
  const key = String(userId);

  const req = config.requestedPlans[key];
  if (req) {
    delete config.requestedPlans[key];
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

  const pendingRaw = config.userInfo[key]?.pending_plan;
  if (pendingRaw) {
    const isCurrentlyAllowed = config.allowed.includes(userId);
    config.userInfo[key] = {
      ...config.userInfo[key],
      pending_plan: undefined,
      plan_status: isCurrentlyAllowed ? "approved" : "rejected",
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
  let changed = false;
  for (const [key, ids] of Object.entries(config.menus)) {
    if (ids.includes(menuId)) {
      config.menus[key] = ids.filter((m) => m !== menuId);
      changed = true;
    }
  }
  if (changed) await persist();
}

// ─── Strategy Requests ───────────────────────────────────────────────────────

/** Solicitud de estrategia (usuario pide acceso; solo el dueño puede aprobar). */
export interface StrategyRequest {
  userId: number;
  menuId: string;
  requestedAt: number;
}

export async function loadStrategyRequestsFromDB(): Promise<StrategyRequest[]> {
  const pg = await import("./infrastructure/database/PostgresStrategyRequestRepository.js");
  return pg.loadStrategyRequestsFromPG();
}

/** Añade una solicitud de estrategia (evita duplicados userId+menuId). */
export async function addStrategyRequest(userId: number, menuId: string): Promise<boolean> {
  const pg = await import("./infrastructure/database/PostgresStrategyRequestRepository.js");
  return pg.addStrategyRequestToPG(userId, menuId);
}

/** Elimina una solicitud (al aprobar o rechazar). */
export async function removeStrategyRequest(userId: number, menuId: string): Promise<boolean> {
  const pg = await import("./infrastructure/database/PostgresStrategyRequestRepository.js");
  return pg.removeStrategyRequestFromPG(userId, menuId);
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

// ─── Testing Config ──────────────────────────────────────────────────────────

export async function saveTestingCutoffDate(date: string | null, userId: number): Promise<void> {
  const pg = await import("./infrastructure/database/PostgresTestingConfigRepository.js");
  return pg.saveTestingCutoffDatePG(date, userId);
}

export async function loadTestingCutoffDate(userId: number): Promise<string | null> {
  const pg = await import("./infrastructure/database/PostgresTestingConfigRepository.js");
  return pg.loadTestingCutoffDatePG(userId);
}

// ─── Sugerencias ─────────────────────────────────────────────────────────────

export interface SugerenciaRow {
  userId: number;
  nombre: string;
  telefono: string;
  texto: string;
  /** Fecha en formato DD/MM/YYYY HH:MM (hora Florida). */
  fecha: string;
}

export const SUGERENCIA_SHEET_INDEX = 5;

export async function loadSugerenciasFromDB(): Promise<SugerenciaRow[]> {
  const pg = await import("./infrastructure/database/PostgresSugerenciaRepository.js");
  return pg.loadSugerenciasFromPG();
}

export async function appendSugerenciaToDB(row: SugerenciaRow): Promise<void> {
  const pg = await import("./infrastructure/database/PostgresSugerenciaRepository.js");
  return pg.appendSugerenciaToPG(row);
}

/** Devuelve todas las sugerencias de un usuario específico. */
export async function getSugerenciaForUser(userId: number): Promise<SugerenciaRow[]> {
  const pg = await import("./infrastructure/database/PostgresSugerenciaRepository.js");
  return pg.getSugerenciaForUserPG(userId);
}

// ─── Announcements ───────────────────────────────────────────────────────────

/** Fila de Announcements: id, texto, fecha. */
export interface AnnouncementRow {
  /** UUID simple (timestamp ms) que sirve como clave para editar/eliminar. */
  id: string;
  texto: string;
  /** Fecha en formato DD/MM/YYYY HH:MM (hora Florida). */
  fecha: string;
}

export const ANNOUNCEMENTS_SHEET_INDEX = 6;

/** TTL del caché de anuncios (2 min). */
const ANNOUNCEMENTS_CACHE_TTL_MS = 2 * 60 * 1000;
let announcementsCache: { at: number; items: AnnouncementRow[] } | null = null;

export function invalidateAnnouncementsCache(): void {
  announcementsCache = null;
}

export async function loadAnnouncementsFromDB(forceRefresh = false): Promise<AnnouncementRow[]> {
  if (!forceRefresh && announcementsCache && Date.now() - announcementsCache.at < ANNOUNCEMENTS_CACHE_TTL_MS) {
    return announcementsCache.items;
  }
  const pg = await import("./infrastructure/database/PostgresAnnouncementRepository.js");
  const items = await pg.loadAnnouncementsFromPG();
  announcementsCache = { at: Date.now(), items };
  return items;
}

export async function saveAnnouncementsToDB(items: AnnouncementRow[]): Promise<void> {
  const pg = await import("./infrastructure/database/PostgresAnnouncementRepository.js");
  await pg.saveAnnouncementsToPG(items);
  announcementsCache = { at: Date.now(), items };
}

/** Añade un nuevo anuncio. Devuelve la lista actualizada. */
export async function addAnnouncement(texto: string, fecha: string): Promise<AnnouncementRow[]> {
  const pg = await import("./infrastructure/database/PostgresAnnouncementRepository.js");
  const items = await pg.addAnnouncementToPG(texto, fecha);
  announcementsCache = { at: Date.now(), items };
  return items;
}

/** Edita el texto de un anuncio por id. */
export async function editAnnouncement(id: string, newTexto: string): Promise<AnnouncementRow[] | null> {
  const pg = await import("./infrastructure/database/PostgresAnnouncementRepository.js");
  const items = await pg.editAnnouncementInPG(id, newTexto);
  if (items) announcementsCache = { at: Date.now(), items };
  return items;
}

/** Elimina un anuncio por id. */
export async function deleteAnnouncement(id: string): Promise<AnnouncementRow[] | null> {
  const pg = await import("./infrastructure/database/PostgresAnnouncementRepository.js");
  const items = await pg.deleteAnnouncementFromPG(id);
  if (items) announcementsCache = { at: Date.now(), items };
  return items;
}

/** Elimina todos los anuncios de una vez. */
export async function clearAllAnnouncements(): Promise<void> {
  await saveAnnouncementsToDB([]);
}

// ─── Leads ───────────────────────────────────────────────────────────────────

/** Fila de Leads: registro permanente de prospectos. */
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

/**
 * Guarda un lead (UPSERT) en PostgreSQL.
 */
export async function saveLead(
  userId: number,
  name: string,
  phone: string,
  plan: string,
  temporality: string,
  status = "trial_active"
): Promise<void> {
  const pg = await import("./infrastructure/database/PostgresLeadRepository.js");
  return pg.saveLeadToPG(userId, name, phone, plan, temporality, status);
}

/** Carga todos los leads. */
export async function loadLeadsFromDB(): Promise<LeadRow[]> {
  const pg = await import("./infrastructure/database/PostgresLeadRepository.js");
  return pg.loadLeadsFromPG();
}

/** Cuenta total de leads registrados. */
export async function getLeadCount(): Promise<number> {
  const pg = await import("./infrastructure/database/PostgresLeadRepository.js");
  const leads = await pg.loadLeadsFromPG();
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

// ─── Gating helpers (acceso abierto con registro) ────────────────────────────

/** true si el usuario ya compartió sus datos de contacto (teléfono). */
export function isRegistered(userId: number): boolean {
  const info = config.userInfo[String(userId)];
  return !!info?.phone;
}

/**
 * true si el usuario tiene un plan activo (no caducado).
 * Owners siempre devuelven true.
 */
export function hasPlan(userId: number): boolean {
  if (getOwnerIds().includes(userId)) return true;
  const info = config.userInfo[String(userId)];
  if (!info?.plan) return false;
  if (info.plan_status !== "approved") return false;
  if (isPlanExpired(userId)) return false;
  return true;
}

/**
 * Guarda nombre + teléfono de un usuario sin asignarle plan ni acceso.
 * Se usa en el flujo de registro previo a la adquisición de plan.
 */
export async function saveUserContact(userId: number, name: string, phone: string): Promise<PersistResult> {
  const key = String(userId);
  config.userInfo[key] = {
    ...config.userInfo[key],
    name,
    phone,
  };
  // Asegurar que el userId esté en allowed para que pueda interactuar
  if (!config.allowed.includes(userId)) {
    config.allowed.push(userId);
  }
  return persist();
}
