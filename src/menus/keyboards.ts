/**
 * Teclados de menús: principal, submenú de juego (Hoy/Ayer/Semana/Fecha), estadísticas, días diferencia.
 */

import { InlineKeyboard } from "grammy";
import type { getOwnerId as GetOwnerId, isOwner as IsOwner, getExtraMenus as GetExtraMenus } from "../user-config.js";
import type {
  getExtraMenuIds as GetExtraMenuIds,
  getExtraMenuLabel as GetExtraMenuLabel,
} from "../menu-registry.js";
import { EXTRA_MENU_CALLBACK_PREFIX } from "../menu-registry.js";
import type { GameMenu } from "./types.js";

export interface MainKeyboardDeps {
  getOwnerId: typeof GetOwnerId;
  isOwner: typeof IsOwner;
  getExtraMenus: (userId: number) => string[];
  getExtraMenuIds: typeof GetExtraMenuIds;
  getExtraMenuLabel: typeof GetExtraMenuLabel;
  /** Opcionales para mostrar icono en estrategias: 📋 plan, ➕ adquirida, ✏️ propia; dueño: 👤 propia, 👥 creada por user. */
  getPlan?: (userId: number) => string | undefined;
  getPlanByTitle?: (title: string) => { menuIds?: string[] } | undefined;
  getUserAssignedMenuIds?: (userId: number) => string[];
  getMenuCreatedBy?: (menuId: string) => number | undefined;
  /** Devuelve el nº de suscriptores de una estrategia custom para mostrarlo en el botón. */
  getMenuSubscribers?: (menuId: string) => number;
}

function getStrategyIcon(
  menuId: string,
  userId: number,
  isOwnerFn: (id: number) => boolean,
  deps: MainKeyboardDeps
): string {
  const createdBy = deps.getMenuCreatedBy?.(menuId);
  const isOwner = isOwnerFn(userId);
  if (isOwner) {
    if (createdBy === undefined || createdBy === 0 || isOwnerFn(createdBy)) return "👤 "; /* propia del dueño */
    return "👥 "; /* creada por un usuario */
  }
  if (createdBy === userId) return "✏️ "; /* propia (creada por ti) */
  const planTitle = deps.getPlan?.(userId);
  const plan = planTitle ? deps.getPlanByTitle?.(planTitle) : undefined;
  const planIds = (plan && "menuIds" in plan ? plan.menuIds : undefined) ?? [];
  if (planIds.includes(menuId)) return "📋 "; /* parte del plan */
  const assigned = deps.getUserAssignedMenuIds?.(userId) ?? [];
  if (assigned.includes(menuId)) return "➕ "; /* adquirida fuera del plan */
  return "";
}

/** Callback al pulsar "➕ Estrategias": abre el submenú de estrategias. */
export const ESTRATEGIAS_OPEN_CALLBACK = "estrategias_open";

/** Mensaje del menú principal — se usa en /start, volver y security_main. */
export const MAIN_MENU_MESSAGE =
  "🎰 *¡Bienvenido a Florida Lottery Bot!*\n\n" +
  "Tu asistente definitivo para Pick 3 y Pick 4. Aquí tienes todo lo que puedes hacer:\n\n" +
  "🔎 *Consultar resultados* — Fijo (P3) y Corrido (P4) de hoy, ayer, esta semana o por fecha exacta.\n\n" +
  "📊 *Estadísticas avanzadas* — Descubre qué números salen más, agrupaciones y tendencias reales.\n\n" +
  "🤖 *Estrategias inteligentes* — Algoritmos que analizan el historial y te dan candidatos para el próximo sorteo.\n\n" +
  "🤝 *Consenso Multi-Estrategia* — Combina varias estrategias y filtra los números con mayor coincidencia.\n\n" +
  "🃏 *Charada Cubana* — Consulta el significado de cualquier número o busca el número de tu sueño.\n\n" +
  "🛒 *Tienda* — Accede a estrategias exclusivas creadas por la comunidad.\n\n" +
  "_Elige una opción y empieza a jugar con ventaja:_";

/** Callback al pulsar "Consultar Datos": abre el submenú de consulta. */
export const CONSULTAR_DATOS_CALLBACK = "consultar_datos_open";

/** Submenú "Consultar Datos" con las opciones de consulta. */
export function buildConsultarDatosKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎯 Fijo (P3)", "menu_fijo")
    .text("🎲 Corrido (P4)", "menu_corrido")
    .row()
    .text("☀️🌙 Ambos (Fijo + Corrido)", "menu_ambos")
    .row()
    .text("📚 Base de datos", "menu_basedatos")
    .row()
    .text("◀️ Volver", "volver");
}

const CONSENSUS_MENU_ID = "consensus_multi";

export function buildMainKeyboard(userId: number | undefined, deps: MainKeyboardDeps): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("🔎 Consultar Datos", CONSULTAR_DATOS_CALLBACK);
  const ownerId = deps.getOwnerId();
  const uid = userId ?? 0;
  const extraIds = deps.getExtraMenuIds();
  const userMenus = deps.getExtraMenus(uid);
  const showExtra = extraIds.filter((id) => {
    if (id === CONSENSUS_MENU_ID) return false;
    if (ownerId === null) return true;
    if (deps.isOwner(uid)) return true;
    return userMenus.includes(id);
  });
  const hasConsensus = extraIds.includes(CONSENSUS_MENU_ID) && (
    ownerId === null || deps.isOwner(uid) || userMenus.includes(CONSENSUS_MENU_ID)
  );
  if (showExtra.length > 0) {
    kb.row().text("➕ Estrategias", ESTRATEGIAS_OPEN_CALLBACK);
  }
  if (hasConsensus) {
    kb.row().text("🤝 Consenso Multi-Estrategia", EXTRA_MENU_CALLBACK_PREFIX + CONSENSUS_MENU_ID);
  }
  kb.row().text("🃏 Charada Cubana", "charada_open");
  kb.row().text("🛒 Tienda", "estrategias_tienda");
  if (ownerId === null || !deps.isOwner(uid)) {
    kb.row().text("❓ Ayuda", "help").text("💬 Sugerencia", "sugerencia_open");
    if (ownerId !== null && !deps.isOwner(uid)) {
      kb.row().text("📋 Cambiar plan", "cambiar_plan_open");
    }
  }
  if (ownerId !== null && deps.isOwner(uid)) {
    kb.row().text("⚙️ Administrar", "security_open").text("🧪 Testing", "testing_open");
    kb.row().text("🔮 Crear Adivinanza", "adivinanza_open");
    kb.row().text("📣 Sugerencia", "admin_sugerencia_open").text("📢 Anuncios", "admin_ann_open");
  }
  return kb;
}

/**
 * Teclado del submenú "➕ Estrategias".
 *
 * - Dueño: ve solo las estrategias asignadas a él (columna menus del Sheet).
 *   Su botón de gestión abre el panel de Seguridad (donde tiene acceso completo).
 * - Usuarios normales: ven solo las estrategias en su getExtraMenus().
 *   Su botón de gestión abre el panel de usuario (crear/eliminar/tienda propias).
 */
export function buildEstrategiasKeyboard(userId: number | undefined, deps: MainKeyboardDeps): InlineKeyboard {
  const ownerId = deps.getOwnerId();
  const uid = userId ?? 0;
  const isOwnerUser = deps.isOwner(uid);
  const extraIds = deps.getExtraMenuIds();

  // Both owner and regular users see only their assigned strategies.
  // Owner has all strategies assigned via seed, so they still see all 9.
  // consensus_multi lives at main-menu level, so it's excluded here.
  const showExtra = extraIds.filter((id) => {
    if (id === CONSENSUS_MENU_ID) return false;
    if (ownerId === null) return true;
    return deps.getExtraMenus(uid).includes(id);
  });

  const kb = new InlineKeyboard();
  for (const id of showExtra) {
    const label = deps.getExtraMenuLabel(id);
    if (label) {
      const icon = getStrategyIcon(id, uid, deps.isOwner, deps);
      const count = isOwnerUser ? (deps.getMenuSubscribers?.(id) ?? 0) : 0;
      const countSuffix = count > 0 ? ` 👤${count}` : "";
      kb.text(icon + label + countSuffix, EXTRA_MENU_CALLBACK_PREFIX + id).row();
    }
  }

  kb.row().text("⚙️ Gestionar estrategias", "estrategias_manage");
  kb.row().text("◀️ Volver", "volver");
  return kb;
}

export function buildSubmenuKeyboard(game: GameMenu): InlineKeyboard {
  const prefix = game === "fijo" ? "fijo" : game === "corrido" ? "corrido" : "ambos";
  return new InlineKeyboard()
    .text("☀️🌙 Hoy", `${prefix}_hoy`)
    .text("☀️🌙 Ayer", `${prefix}_ayer`)
    .row()
    .text("📆 Esta semana", `${prefix}_semana`)
    .row()
    .text("📅 Escoger fecha", `${prefix}_fecha`)
    .row()
    .text("◀️ Volver", CONSULTAR_DATOS_CALLBACK);
}

export function buildEstadisticasKeyboard(threshold: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("☀️ Mediodía (M)", "stats_grupos_M")
    .text("🌙 Noche (E)", "stats_grupos_E")
    .row()
    .text(`🔢 Días diferencia: ${threshold}`, "stats_set_days")
    .row()
    .text("◀️ Volver", "volver");
}

export function buildIndividualPeriodKeyboard(threshold: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("☀️ Mediodía (M)", "stats_individual_M")
    .text("🌙 Noche (E)", "stats_individual_E")
    .row()
    .text(`🔢 Días diferencia: ${threshold}`, "stats_individual_set_days")
    .row()
    .text("◀️ Volver", "volver");
}

export function buildDiasDiferenciaKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("1", "stats_days_1")
    .text("3", "stats_days_3")
    .text("5", "stats_days_5")
    .text("7", "stats_days_7")
    .text("10", "stats_days_10")
    .row()
    .text("◀️ Volver", "volver");
}

export function buildDiasDiferenciaKeyboardIndividual(): InlineKeyboard {
  return new InlineKeyboard()
    .text("1", "stats_individual_days_1")
    .text("3", "stats_individual_days_3")
    .text("5", "stats_individual_days_5")
    .text("7", "stats_individual_days_7")
    .text("10", "stats_individual_days_10")
    .row()
    .text("◀️ Volver", "stats_individual_back");
}

/**
 * Teclado del menú Testing (solo dueño).
 * currentDate = fecha activa "MM/DD/YY" o null si no hay corte.
 */
export function buildTestingKeyboard(currentDate: string | null): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("📅 Cambiar fecha", "testing_cambiar");
  if (currentDate) {
    kb.text("🗑 Eliminar", "testing_eliminar");
  }
  kb.row()
    .text("📈 Progresivo", "prog_open")
    .text("🚀 BallBackTest", "bbt_open")
    .row()
    .text("◀️ Volver", "volver");
  return kb;
}

/** Construye el mensaje de contexto para el menú Testing. */
export function buildTestingMessage(currentDate: string | null): string {
  const status = currentDate
    ? `✅ *Activo* — fecha de corte: \`${currentDate}\`\nLas estrategias usarán solo sorteos _hasta_ esa fecha.`
    : `⭕ *Inactivo* — se usa la base de conocimientos completa.`;
  return (
    `🧪 *Modo Testing*\n\n` +
    `${status}\n\n` +
    `Pulsa *Cambiar fecha* para fijar un corte o *Eliminar* para quitar el filtro.\n` +
    `_Los cambios manuales en el Sheet también se reflejan (caché de 5 min)._`
  );
}

// ─── Sugerencia keyboards ───────────────────────────────────────────────────────

/** Menú principal de Sugerencia para usuarios normales. */
export function buildSugerenciaKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✉️ Enviar sugerencia", "sugerencia_enviar")
    .row()
    .text("📋 Mis sugerencias", "sugerencia_mis_p:0")
    .row()
    .text("◀️ Volver", "volver");
}

/** Teclado paginado de la lista de usuarios con sugerencia (admin). */
export function buildAdminSugerenciaListKeyboard(
  page: number,
  totalPages: number,
  userSummaries: Array<{ userId: number; nombre: string }>
): InlineKeyboard {
  const kb = new InlineKeyboard();
  // Botones de usuario (uno por fila)
  for (const u of userSummaries) {
    const label = u.nombre || `User ${u.userId}`;
    kb.text(`👤 ${label}`, `admin_sugerencia_user:${u.userId}_p:0`).row();
  }
  // Paginación
  if (totalPages > 1) {
    if (page > 0) kb.text("◀ Anterior", `admin_sugerencia_p:${page - 1}`);
    if (page < totalPages - 1) kb.text("Siguiente ▶", `admin_sugerencia_p:${page + 1}`);
    kb.row();
  }
  kb.text("◀️ Volver", "volver");
  return kb;
}

/** Teclado de los mensajes de un usuario específico (admin), con paginación. */
export function buildAdminUserSugerenciaKeyboard(
  targetUserId: number,
  page: number,
  totalPages: number
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (totalPages > 1) {
    if (page > 0) kb.text("◀ Anterior", `admin_sugerencia_user:${targetUserId}_p:${page - 1}`);
    if (page < totalPages - 1) kb.text("Siguiente ▶", `admin_sugerencia_user:${targetUserId}_p:${page + 1}`);
    kb.row();
  }
  kb.text("◀️ Ver lista", "admin_sugerencia_open").row();
  kb.text("◀️ Menú principal", "volver");
  return kb;
}

/** Teclado de paginación para "Mis sugerencias" (usuario). */
export function buildMySugerenciasKeyboard(
  page: number,
  totalPages: number
): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (totalPages > 1) {
    if (page > 0) kb.text("◀ Anterior", `sugerencia_mis_p:${page - 1}`);
    if (page < totalPages - 1) kb.text("Siguiente ▶", `sugerencia_mis_p:${page + 1}`);
    kb.row();
  }
  kb.text("◀️ Volver", "sugerencia_open");
  return kb;
}
