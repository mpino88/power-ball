/**
 * Bot de Telegram: Florida Lottery Pick 3 y Pick 4 — resultados desde los PDF oficiales.
 * Arquitectura por módulos: security (acceso, administración), menus (teclados y callbacks).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createAutoDrawHandler, type AutoDrawRequest } from "./auto-draw.js";
import { Bot, InputFile, InlineKeyboard } from "grammy";
import type { Update } from "grammy/types";
import {
  getOwnerId,
  getOwnerIds,
  isAllowed,
  getExtraMenus,
  getPlan,
  getPendingPlan,
  getPendingPlanTitle,
  getPendingPlanTemporality,
  getPlanTemporality,
  getPlanExpiry,
  isPlanExpired,
  getUserAssignedMenuIds,
  isOwner,
  initUserConfig,
  addPlanRequest,
  addAllowed,
  setExtraMenus,
  requestPlanChange,
  reloadConfigFromStorage,
  setSheetMenuLabelResolver,
  toggleExtraMenu,
  getStorageBackend,
  loadStrategiesFromDB,
  saveStrategiesToDB,
  loadPlansFromDB,
  savePlansToDB,
  normalizeUserMenusAfterLoad,
  loadTestingCutoffDate,
  saveTestingCutoffDate,
  loadSugerenciasFromDB,
  appendSugerenciaToDB,
  getSugerenciaForUser,
  getUsername,
  getPhone,
  loadAnnouncementsFromDB,
  addAnnouncement,
  editAnnouncement,
  deleteAnnouncement,
  clearAllAnnouncements,
  invalidateAnnouncementsCache,
  getAllowedUsers,
  hasPlan,
  isRegistered,
} from "./user-config.js";
import {
  registerExtraMenu,
  getHandler,
  getExtraMenuLabel,
  getExtraMenuDescription,
  getExtraMenuStatus,
  getExtraMenuIds,
  EXTRA_MENU_CALLBACK_PREFIX,
} from "./menu-registry.js";
import {
  initCustomMenus,
  initCustomMenusFromDB,
  setStrategyDbPersist,
  getCustomMenus,
  getMenuCreatedBy,
  getMenuSubscribers,
  seedCustomMenus,
} from "./custom-menus.js";
import { initPlans, initPlansFromDB, setPlanDbPersist, getPlans, updatePlan, getPlanById, getPlanByTitle, TEMPORALITIES, getPriceForTemporality, formatPlanPrice } from "./plans.js";
import {
  buildGroupStatsMessage as buildGroupStatsMessageFromStats,
  buildIndividualTop10Message as buildIndividualTop10MessageFromStats,
} from "./stats-p3.js";

import {
  createRestrictMiddleware,
  handleSecurityCallback,
  handleEstrategiasUserCallback,
  handleSecurityMessage,
  buildSecurityKeyboard,
  buildManagePlansKeyboard,
  clearAllFlows,
  creatingPlanFlow,
  editingPlanFlow,
  escapeMd,
} from "./security/index.js";
import {
  buildMainKeyboard,
  buildEstrategiasKeyboard,
  buildEstadisticasKeyboard,
  buildIndividualPeriodKeyboard,
  buildTestingKeyboard,
  buildTestingMessage,
  buildSugerenciaKeyboard,
  buildAdminSugerenciaListKeyboard,
  buildAdminUserSugerenciaKeyboard,
  buildMySugerenciasKeyboard,
  handleMenuCallback,
  ESTRATEGIAS_OPEN_CALLBACK,
  buildMainMenuMessage,
  type GameMenu,
} from "./menus/index.js";
import type { StrategyContext } from "./strategies/types.js";
import {
  buildStrategyContextKeyboard,
  getStrategyContextMessage,
  parseStrategyContextCallback,
  runStrategy,
  hasStrategyRunner,
  getStrategy,
  getConsensusSelectableIds,
} from "./strategies/index.js";
import { warmUpCandidateCache } from "./candidate-cache.js";

import { filterMapByCutoff, getNextDrawResult, buildTestingVerificationBlock, mmddyyToDate, getStrategiesTopN, getUserTopN, setUserTopN, runWithUserTopN } from "./strategies/utils.js";
import { STRATEGY_CONTEXT_CALLBACK_PREFIX } from "./strategies/types.js";
import {
  runConsensusAggregation,
  buildConsensusSelectionKeyboard,
  buildConsensusSelectionMessage,
  CONSENSUS_GROUPS,
} from "./strategies/consensus-multi.js";
import {
  buildParleMessage,
  buildParleCallback,
  parseParleCallback,
  PARLE_CNS_CALLBACK,
} from "./strategies/parle.js";
import {
  runProgressiveAnalysis,
  countDatesInRange,
  buildProgressiveContextKeyboard,
  buildProgressiveStrategyMessage,
  buildProgressiveStrategyKeyboard,
  buildProgressiveResultMessage,
  PROGRESSIVE_TOP_N,
  PROGRESSIVE_MAX_DATES,
  PROGRESSIVE_WARN_THRESHOLD,
  PROGRESSIVE_MAX_STRATEGIES,
  type ProgressiveSession,
} from "./strategies/progressive.js";

import { loadStrategyPreviews, saveStrategyPreviews, hasPreviewedStrategy, markStrategyAsPreviewed } from "./strategy-previews.js";
import {
  runBallBackTest,
  buildBBTContextKeyboard,
  buildBBTStrategyKeyboard,
  buildBBTStrategyMessage,
  buildBBTResultMessage,
  BBT_MAX_STRATEGIES,
  type BallBackTestSession,
  runBBTCompare,
  buildBBTCompareStrategyKeyboard,
  buildBBTComparePeriodKeyboard,
  buildBBTCompareLimitKeyboard,
  buildBBTCompareResultMessage,
  type BBTCompareSession,
  type BBTCmpPeriodId,
} from "./strategies/ball-backtest.js";
import {
  buildCharadaMenuKeyboard,
  buildCharadaCatalogKeyboard,
  buildCatalogPage,
  searchCharada,
  buildSearchMessage,
} from "./charada.js";
import {
  ADIVINANZA_OPEN_CB,
  ADIVINANZA_INGRESAR_CB,
  ADIVINANZA_REGEN_CB,
  ADIVINANZA_STRAT_PREFIX,
  ADIVINANZA_CNS_CALLBACK,
  ADIVINANZA_OPEN_MSG,
  generarAdivinanza,
  listarModelosGemini,
  buildAdivinanzaMenuKeyboard,
  buildAdivinanzaResultKeyboard,
  buildAdivinanzaResultMsg,
  buildAdivinanzaStratCallback,
  parseAdivinanzaStratCallback,
  parseNumberList,
} from "./adivinanza.js";
import { getPaymentMethods, loadPaymentMethodsFromDB } from "./payment-methods.js";

const isDev = process.env.NODE_ENV === "development";

// Option fallback to load .env if present (e.g. for local production test or manual upload)
try {
  const fs = require("node:fs");
  if (fs.existsSync(".env")) {
    process.loadEnvFile(".env");
  }
} catch (e) {
  // Ignore errors
}

const BOT_TOKEN = (isDev ? process.env.TELEGRAM_BOT_TOKEN_DEV : process.env.TELEGRAM_BOT_TOKEN) || process.env.TELEGRAM_BOT_TOKEN || "";

if (!BOT_TOKEN) {
  console.error("❌ ERROR CRÍTICO: No se encontró TELEGRAM_BOT_TOKEN (o TELEGRAM_BOT_TOKEN_DEV) en el entorno.");
  console.error("👉 Ve a tu panel de configuración (ej. Render) o archivo .env y añade la variable TELEGRAM_BOT_TOKEN.");
  process.exit(1);
}

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WEBHOOK_URL = isDev ? "" : (process.env.WEBHOOK_URL ?? "");
const FLORIDA_TZ = "America/New_York";
const REQUEST_ACCESS_LINK = process.env.REQUEST_ACCESS_LINK?.trim() ?? "";
const STRATEGY_STORE_PREVIEW_CALLBACK_PREFIX = "stpv_";

/** Ruta local de la imagen de onboarding para nuevos usuarios. */
const ONBOARDING_IMAGE_PATH = path.join(process.cwd(), "src", "assets", "onboarding-new-user.jpg");
/** file_id cacheado de Telegram tras el primer envío (evita releer el disco). */
let onboardingPhotoFileId: string | null = null;

/** TTL (ms) para sincronizar precios de planes desde la DB (5 min). */
const PLAN_RELOAD_TTL_MS = 5 * 60 * 1000;
let lastPlanReload = 0;

/** Recarga los planes desde PG si el caché tiene más de 5 minutos de antigüedad. */
async function reloadPlansIfStale(): Promise<void> {
  if (getStorageBackend() !== "postgres") return;
  const now = Date.now();
  if (now - lastPlanReload < PLAN_RELOAD_TTL_MS) return;
  lastPlanReload = now;
  try {
    const rows = await loadPlansFromDB();
    if (rows.length > 0) initPlansFromDB(rows);
  } catch (e) {
    console.error("[plans] Error al recargar planes desde DB:", e);
  }
}

/**
 * Recarga las estrategias desde la DB.
 * Se llama cada vez que el usuario abre la Tienda para garantizar visibilidad actualizada.
 */
async function reloadStrategiesIfStale(): Promise<void> {
  if (getStorageBackend() !== "postgres") return;
  try {
    const rows = await loadStrategiesFromDB();
    if (rows.length > 0) initCustomMenusFromDB(rows);
  } catch (e) {
    console.error("[strategies] Error al recargar estrategias desde DB:", e);
  }
}

function buildHelpText(planName: string): string {
  const safePlan = escapeMd(planName);
  return (
    `📋 *Ayuda — ${safePlan}*\n\n` +
    `Ud. posee el plan *${safePlan}*: le brindamos acceso a sus estadísticas y estrategias configuradas.\n\n` +
    "Si requiere implementar su propia solución con un costo adicional, contacte al administrador.\n\n" +
    "Note que esas funciones las podrá comercializar con otros usuarios a través de la aplicación y por medio del admin."
  );
}

let hotThresholdDays = 5;
const waitingCustomDateGame = new Map<number, GameMenu>();


interface ConsensusSession {
  context: StrategyContext;
  selectedIds: Set<string>;
  step: "selecting" | "waiting_count";
  isPreview?: boolean;
}
const consensusSessionMap = new Map<number, ConsensusSession>();

/** Usuarios que están esperando introducir una búsqueda en la Charada. */
const waitingCharadaSearch = new Map<number, true>();

/**
 * Caché de números para el parlé del Consenso Multi-Estrategia.
 * Se sobrescribe en cada resultado de consenso; expira al calcular uno nuevo.
 */
const parleConsensusCache = new Map<number, { nums: number[]; context: StrategyContext }>();

/**
 * Caché de números para la adivinanza del Consenso Multi-Estrategia (solo dueño).
 * Se sobrescribe con cada nuevo resultado de consenso.
 */
const adivinanzaConsensusCache = new Map<number, number[]>();

/**
 * Últimos números usados para generar una adivinanza por userId (solo dueño).
 * Permite el botón "🔄 Regenerar" sin codificar números en el callback.
 */
const adivinanzaLastNums = new Map<number, number[]>();

/** Sesiones activas del Análisis Progresivo (solo para el dueño del bot). */
const progressiveSessionMap = new Map<number, ProgressiveSession>();
const progressiveResultCache = new Map<number, Buffer>();

const bbtSessionMap = new Map<number, BallBackTestSession>();
const bbtResultCache = new Map<number, Buffer>();
const waitingBBTDate = new Map<number, "start" | "end">();
const waitingBBTTopN = new Set<number>();

// BBT Compare state
const bbtCmpSessionMap = new Map<number, BBTCompareSession>();
const waitingBBTCmpLimit = new Set<number>();

/**
 * Retorna los IDs de estrategias seleccionables en Consenso Multi-Estrategia
 * filtrados por los menús que el usuario tiene activos (plan + asignados).
 * Los owners ven todas las estrategias registradas.
 */
function getAccessibleStrategyIds(userId: number): string[] {
  const all = getConsensusSelectableIds();
  if (isOwner(userId)) return all;
  const userMenus = new Set(getExtraMenus(userId));
  return all.filter((id) => userMenus.has(id));
}

/**
 * Usuarios esperando ingreso de texto para el análisis progresivo.
 * "start" = esperando fecha inicial, "end" = esperando fecha final.
 */
const waitingProgressiveDate = new Map<number, "start" | "end">();

/** Sesiones activas esperando límite de candidatos en UNODOSTRES+. */
const waitingPlusLimit = new Map<number, { menuId: string; context: StrategyContext }>();

/**
 * Caché de la fecha de corte de testing — por userId (5 min TTL).
 * Cada admin tiene su propia entrada independiente.
 */
const TESTING_CUTOFF_TTL_MS = 5 * 60 * 1000;
const cachedTestingCutoff = new Map<number, { at: number; date: string | null }>();

async function getTestingCutoff(userId: number): Promise<string | null> {
  const now = Date.now();
  const cached = cachedTestingCutoff.get(userId);
  if (cached && now - cached.at < TESTING_CUTOFF_TTL_MS) {
    return cached.date;
  }
  const date = await loadTestingCutoffDate(userId);
  cachedTestingCutoff.set(userId, { at: now, date });
  if (date) console.log(`[testing] Fecha de corte activa para userId=${userId}: ${date}`);
  return date;
}

/** Invalida la caché de cutoff de un userId para que la próxima lectura vaya al Sheet. */
function invalidateTestingCutoffCache(userId: number): void {
  cachedTestingCutoff.delete(userId);
}

/** Usuarios (solo el dueño) esperando introducir una fecha de testing. */
const waitingTestingDate = new Map<number, true>();

/** Dueño esperando ingresar lista de números para generar una adivinanza. */
const waitingAdivinanzaNums = new Map<number, true>();

/** Usuarios esperando introducir el texto de una sugerencia. */
const waitingSugerenciaText = new Map<number, true>();

/**
 * Estado del flujo de anuncios del admin.
 * "create" = esperando texto nuevo; "edit:<id>" = esperando texto editado.
 */
const waitingAnnouncementInput = new Map<number, "create" | string>();

/**
 * Versiones de getP3Map/getP4Map con:
 *  1. Merge de hoy-results.json → cierra el punto ciego cross-period:
 *     cuando una estrategia "ambos" (mediodía+noche) se ejecuta por la noche,
 *     el resultado del mediodía de hoy ya está disponible via hoy-results aunque
 *     el PDF aún no haya sido refrescado o el caché esté desactualizado.
 *  2. Filtro de fecha de corte para modo testing (solo owners).
 *
 * NOTE: el merge NO aplica en testing mode (cutoff activo) — la simulación
 * histórica no debe contaminarse con datos en vivo de hoy.
 */
async function getStrategyP3Map(userId?: number): Promise<DateDrawsMap> {
  const map = await getP3Map();
  const cutoff = isOwner(userId ?? 0) ? await getTestingCutoff(userId ?? 0) : null;
  if (cutoff) return filterMapByCutoff(map, cutoff);
  // Merge today's hoy-results so cross-period strategies always have the latest data
  const { getHoyResult: getHoy, getTodayEST: todayEST, mergeHoyIntoP3Map } = await import("./hoy-results.js");
  return mergeHoyIntoP3Map(map, getHoy(), todayEST());
}

async function getStrategyP4Map(userId?: number): Promise<DateDrawsMap> {
  const map = await getP4Map() as DateDrawsMap;
  const cutoff = isOwner(userId ?? 0) ? await getTestingCutoff(userId ?? 0) : null;
  if (cutoff) return filterMapByCutoff(map, cutoff);
  // Merge today's hoy-results so cross-period strategies always have the latest data
  const { getHoyResult: getHoy, getTodayEST: todayEST, mergeHoyIntoP4Map } = await import("./hoy-results.js");
  return mergeHoyIntoP4Map(map, getHoy(), todayEST());
}

/** Timeout (ms) para ejecutar una estrategia; evita "Calculando…" infinito si getP3Map/run tardan. */
const STRATEGY_RUN_TIMEOUT_MS = 90_000;

/** Contexto por defecto al abrir una estrategia desde el menú (P3 Mediodía). */
const DEFAULT_STRATEGY_CONTEXT: StrategyContext = { mapSource: "p3", period: "m" };

/**
 * Convierte un Set de IDs de contexto BBT ("p3_m", "p3_e", "p3_a", "p4_m", "p4_e")
 * a StrategyContext[]. El caso especial "p3_a" / "p4_a" produce un contexto con
 * period="m" + params.ambos=true, que activa el modo Ambos en estrategias que lo soporten.
 */
function bbtContextsFromSet(selected: Set<string>): StrategyContext[] {
  return [...selected].map(cid => {
    const parts = cid.split("_");
    const ms = parts[0] as "p3" | "p4";
    const p = parts[1]!;
    if (p === "a") return { mapSource: ms, period: "m" as const, params: { ambos: true } };
    return { mapSource: ms, period: p as "m" | "e" };
  });
}

/** Ejecuta el motor de comparación y muestra el resultado al owner. */
async function runAndShowCmpResult(
  ctx: { reply: (text: string, opts?: object) => Promise<unknown> },
  userId: number,
  session: BBTCompareSession
): Promise<void> {
  bbtCmpSessionMap.delete(userId);
  waitingBBTCmpLimit.delete(userId);

  const stratIds = [...session.selectedIds];
  const periods = [...session.selectedPeriods] as BBTCmpPeriodId[];

  const progressMsg = await ctx.reply(
    `⏳ *Comparando estrategias…*\n\n` +
    `🎯 Top ${session.limit} · ${stratIds.length} estrategias · ${periods.length} período(s)`,
    { parse_mode: "Markdown" }
  ) as { chat: { id: number }; message_id: number };

  try {
    const result = await runBBTCompare(
      stratIds,
      periods,
      session.limit,
      async (source) => source === "p3" ? await getP3Map() : (await getP4Map()) as DateDrawsMap,
      getStrategy
    );

    const getLabel = (id: string) => STRATEGY_LABEL_BY_ID.get(id) ?? id;
    const msg = buildBBTCompareResultMessage(result, getLabel);

    await (ctx as any).api?.editMessageText(
      progressMsg.chat.id, progressMsg.message_id, msg,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🏠 Inicio", "volver") }
    ).catch(async () => {
      // fallback si no hay api directo en ctx
      await ctx.reply(msg, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🏠 Inicio", "volver"),
      });
    });
  } catch (err) {
    console.error("[bbt_cmp] Error:", err);
    await ctx.reply("❌ Error al ejecutar comparación. Revisa los logs.");
  }
}

/**
 * Ejecuta la estrategia con el contexto dado y muestra la salida en el mensaje.
 * Usado tanto al pulsar "menu_<id>" (un clic = salida) como al pulsar "strat_<id>_p3_m" (cambio de base/período).
 */
async function showStrategyContextSelection(
  ctx: {
    from?: { id: number };
    answerCallbackQuery: (opts?: { text?: string }) => Promise<unknown>;
    editMessageText: (text: string, opts?: object) => Promise<unknown>;
  },
  menuId: string,
  source: "mine" | "store" = "mine"
): Promise<void> {
  await ctx.answerCallbackQuery();
  const title = getExtraMenuLabel(menuId) || menuId;
  const stratDef = getStrategy(menuId);
  const desc = stratDef?.description || getExtraMenuDescription(menuId);

  // Para estrategias propias del usuario, usar el mensaje y teclado definidos en
  // la estrategia. Esto permite opciones exclusivas por estrategia (ej. P3 Ambos
  // en unodostres_plus) sin hardcodear el teclado genérico.
  if (source === "mine" && stratDef) {
    const escapedDesc = desc ? escapeMd(desc) : undefined;
    const msg = stratDef.getContextMessage(title, escapedDesc);
    const kb = stratDef.buildContextKeyboard(menuId);
    await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
    return;
  }

  // Fallback genérico para previsualizaciones de tienda o estrategias sin runner.
  const resultKb = new InlineKeyboard();
  const pre = source === "store"
    ? `${STRATEGY_STORE_PREVIEW_CALLBACK_PREFIX}${menuId}_`
    : `${STRATEGY_CONTEXT_CALLBACK_PREFIX}${menuId}_`;

  resultKb
    .text("P3 (Fijos) ☀️ Mediodía", `${pre}p3_m`)
    .text("P3 (Fijos) 🌙 Noche", `${pre}p3_e`)
    .row()
    .text("P4 (Corridos) ☀️ Mediodía", `${pre}p4_m`)
    .text("P4 (Corridos) 🌙 Noche", `${pre}p4_e`)
    .row();

  if (source === "store") {
    resultKb.text("🔙 Volver a Detalles", `estrategias_request_${menuId}`).row();
    resultKb.text("🛒 Volver a Tienda", "estrategias_tienda");
  } else {
    resultKb.text("🔙 Volver a Estrategias", ESTRATEGIAS_OPEN_CALLBACK).row();
    resultKb.text("🏠 Volver al Inicio", "volver");
  }

  const promptText = source === "store" ? "Previa de Estrategia" : "Estrategia";
  let msg = `🎯 *${promptText}:* ${escapeMd(title)}`;
  if (desc) msg += `\n\n_${escapeMd(desc)}_`;

  const selectionPrompt = source === "store"
    ? "Por favor, selecciona la base de conocimiento y el período que deseas usar para la previsualización:"
    : "Por favor, selecciona la base de conocimiento y el período que deseas analizar:";
  msg += `\n\n${selectionPrompt}`;

  await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: resultKb });
}

async function runStrategyAndShowResult(
  ctx: {
    from?: { id: number };
    answerCallbackQuery: (opts?: { text?: string }) => Promise<unknown>;
    editMessageText: (text: string, opts?: object) => Promise<unknown>;
    reply?: (text: string, opts?: object) => Promise<unknown>;
  },
  menuId: string,
  context: StrategyContext,
  isPreview = false
): Promise<void> {
  await ctx.answerCallbackQuery({ text: "Calculando…" });
  const userId = ctx.from?.id;
  try {
    const runPromise = runWithUserTopN(userId ?? 0, () =>
      runStrategy(menuId, context, {
        getP3Map: () => getStrategyP3Map(userId),
        getP4Map: () => getStrategyP4Map(userId),
      })
    );
    const timeoutPromise = new Promise<string>((_, reject) => {
      setTimeout(() => reject(new Error("STRATEGY_TIMEOUT")), STRATEGY_RUN_TIMEOUT_MS);
    });
    let msg = await Promise.race([runPromise, timeoutPromise]);
    if (userId && !isOwner(userId)) {
      const creatorId = getMenuCreatedBy(menuId) ?? getOwnerId();
      if (creatorId) msg += `\n\n[📩 Contactar al dueño](tg://user?id=${creatorId})`;
    }
    const stratDef = getStrategy(menuId);

    const { getExtraMenuDescription } = await import("./menu-registry.js");
    const { escapeMd } = await import("./security/callbacks.js");
    let desc = stratDef?.description || getExtraMenuDescription(menuId);
    if (desc) {
      desc = escapeMd(desc);
      const firstBreak = msg.indexOf("\n\n");
      if (firstBreak !== -1) {
        msg = msg.slice(0, firstBreak) + `\n\n_${desc}_` + msg.slice(firstBreak);
      }
    }

    const resultKb = new InlineKeyboard();
    if (isPreview) {
      resultKb.text("✅ Solicitar Acceso", `estrategias_confirm_request_${menuId}`).row();
      const stPre = `${STRATEGY_STORE_PREVIEW_CALLBACK_PREFIX}${menuId}_`;
      resultKb
        .text("P3 (Fijos) ☀️ Mediodía", `${stPre}p3_m`)
        .text("P3 (Fijos) 🌙 Noche", `${stPre}p3_e`)
        .row()
        .text("P4 (Corridos) ☀️ Mediodía", `${stPre}p4_m`)
        .text("P4 (Corridos) 🌙 Noche", `${stPre}p4_e`)
        .row();
      resultKb.text("◀️ Volver a Detalles", `estrategias_request_${menuId}`).row();
      resultKb.text("🛒 Volver a Tienda", "estrategias_tienda");
    } else {
      if (stratDef?.getCandidates) {
        resultKb.text("🎰 Hacer parlé", buildParleCallback(menuId, context.mapSource, context.period));
        if (userId && isOwner(userId)) {
          resultKb.text("🔮 Crear Adivinanza", buildAdivinanzaStratCallback(menuId, context.mapSource, context.period));
        }
        resultKb.row();
      }
      // Usar el teclado de contexto propio de la estrategia para los botones de
      // re-ejecución, preservando opciones exclusivas (ej. P3 Ambos en unodostres_plus).
      // Se omite la última fila (◀️ Volver) para agregar navegación específica del resultado.
      const contextKb = stratDef?.buildContextKeyboard(menuId);
      if (contextKb) {
        const rows = contextKb.inline_keyboard;
        const dataRows = rows.slice(0, -1); // omitir fila ◀️ Volver
        for (const row of dataRows) {
          for (const btn of row) {
            if ("callback_data" in btn && btn.callback_data) resultKb.text(btn.text, btn.callback_data);
          }
          resultKb.row();
        }
      } else {
        const pre = `${STRATEGY_CONTEXT_CALLBACK_PREFIX}${menuId}_`;
        resultKb
          .text("P3 (Fijos) ☀️ Mediodía", `${pre}p3_m`)
          .text("P3 (Fijos) 🌙 Noche", `${pre}p3_e`)
          .row()
          .text("P4 (Corridos) ☀️ Mediodía", `${pre}p4_m`)
          .text("P4 (Corridos) 🌙 Noche", `${pre}p4_e`)
          .row();
      }
      resultKb.text("🔄 Probar otra estrategia", ESTRATEGIAS_OPEN_CALLBACK).row();
      resultKb.text("🏠 Volver al Inicio", "volver");
    }

    await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: resultKb });
    if (userId && isOwner(userId) && ctx.reply && !isPreview) {
      const cutoff = await getTestingCutoff(userId);
      if (cutoff) {
        try {
          const isP3 = context.mapSource === "p3";
          const fullMap = isP3 ? await getP3Map() : (await getP4Map()) as DateDrawsMap;
          const nextResult = getNextDrawResult(fullMap, cutoff, context.period, context.mapSource);
          if (nextResult) {
            const strat = getStrategy(menuId);
            let candidates: number[] = [];
            if (strat?.getCandidates) {
              const filteredMap = isP3 ? await getStrategyP3Map(userId) : await getStrategyP4Map(userId);
              candidates = await runWithUserTopN(userId ?? 0, () =>
                strat.getCandidates!(context, filteredMap)
              );
            }
            const verifBlock = buildTestingVerificationBlock(nextResult, candidates, context);
            await ctx.reply(verifBlock, { parse_mode: "Markdown" });
          }
        } catch (verifErr) {
          console.error("[testing-verif] Error al generar verificación:", verifErr);
        }
      }
    }
  } catch (err) {
    console.error("Error runStrategy:", err);
    await ctx.answerCallbackQuery({ text: "Error al calcular" }).catch(() => { });
    const isTimeout = err instanceof Error && err.message === "STRATEGY_TIMEOUT";
    const userMsg = isTimeout
      ? "⏱ _La estrategia tardó demasiado._ Vuelve a intentarlo o prueba más tarde."
      : "❌ Error al ejecutar la estrategia. Vuelve a intentarlo.";
    try {
      await ctx.editMessageText(userMsg, {
        parse_mode: isTimeout ? "Markdown" : undefined,
        reply_markup: buildMainKb(ctx.from?.id),
      });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
  }
}

/** Caché del scrape "Hoy" (10 min); solo la fuente PDF se precarga, el resto es on demand. */
const HOY_CACHE_TTL_MS = 10 * 60 * 1000;

/** En Render (o DISABLE_PUPPETEER) no se usa navegador; "Hoy" se obtiene del PDF oficial. */
const PUPPETEER_DISABLED =
  process.env.RENDER === "true" || process.env.DISABLE_PUPPETEER === "true";



const mainKbDeps = {
  getOwnerId,
  isOwner,
  getExtraMenus,
  getExtraMenuIds,
  getExtraMenuLabel,
  getPlan,
  getPlanByTitle,
  getUserAssignedMenuIds,
  getMenuCreatedBy,
  getMenuSubscribers,
  hasPlan,
  isRegistered,
};

function buildMainKb(userId: number | undefined) {
  return buildMainKeyboard(userId, mainKbDeps);
}

/** Mensaje cuando el usuario abre un menú/estrategia sin funcionalidad asignada. */
const MENU_PENDIENTE_MESSAGE =
  "⏳ _Esta estrategia está pendiente de implementación por el administrador. Vuelve pronto._";

/** Handler para menús creados por el dueño que aún no tienen lógica en código. */
async function placeholderMenuHandler(ctx: {
  answerCallbackQuery: () => Promise<unknown>;
  editMessageText: (text: string, opts?: object) => Promise<unknown>;
  from?: { id: number };
}): Promise<void> {
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText(MENU_PENDIENTE_MESSAGE, {
      parse_mode: "Markdown",
      reply_markup: buildMainKb(ctx.from?.id),
    });
  } catch (e) {
    if (!(e as Error).message?.includes("message is not modified")) console.error(e);
  }
}

function registerExtraMenus(): void {
  registerExtraMenu(
    "est_grupos",
    "📊 Est. grupos",
    async (ctx) => {
      await ctx.answerCallbackQuery();
      const result =
        "📊 *Estadísticas por Grupos — Fijo P3*\n\n" +
        "Analiza el historial completo de sorteos agrupando los números por sus características:\n\n" +
        "🔢 *Terminales (0-9)* — Dígito de unidad del número sorteado. Detecta qué terminal sale más, cuál está caliente y cuál lleva más tiempo sin aparecer.\n\n" +
        "🔟 *Iniciales (0-9)* — Primer dígito del número. Revela qué prefijos dominan y cuáles están rezagados.\n\n" +
        "♊ *Dobles* — Números con dígitos repetidos (00, 11, 22 … 99). Seguimiento específico de frecuencia y brecha de los pares.\n\n" +
        `🔥 *Hot* — Un número se considera caliente cuando su brecha actual ≤ ${hotThresholdDays} días de diferencia con su máximo histórico de ausencia. Ajustable con el botón «Días diferencia».\n\n` +
        "_Elige el período para ver el análisis:_";
      try {
        await ctx.editMessageText(result, {
          parse_mode: "Markdown",
          reply_markup: buildEstadisticasKeyboard(hotThresholdDays),
        });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
    },
    {
      description: "Estadísticas por grupos (terminales, iniciales, dobles) para Fijo P3.",
      isPlaceholder: false,
    }
  );
}

// ─── Built-in strategies catalog ─────────────────────────────────────────────
// Every strategy that has a StrategyDefinition registered in the engine should
// appear here. The seed runs once at startup and is idempotent (skips existing).
const BUILT_IN_STRATEGIES: Array<{ id: string; label: string; description: string; createdBy?: number }> = [
  {
    id: "max_per_week_day",
    label: "Más salidores x día de la Semana",
    description: "Números que más han salido por cada día de la semana (P3/P4, Día/Noche)",
  },
  {
    id: "freq_analysis",
    label: "Análisis de Frecuencia",
    description:
      "Top 20 más frecuentes y top 10 más fríos con probabilidad % e historial. P3/P4 · Día/Noche",
  },
  {
    id: "gap_due",
    label: "Números Debidos (Gap)",
    description:
      "Factor de deuda: días sin salir ÷ brecha promedio histórica. Detecta números atrasados. P3/P4 · Día/Noche",
  },
  {
    id: "calendar_pattern",
    label: "Patrón Calendario",
    description:
      "Números más probables según día de la semana, mes y día del mes. Predice basado en la próxima fecha estimada. P3/P4 · Día/Noche",
  },
  {
    id: "transition_follow",
    label: "Seguidor de Secuencias",
    description:
      "Cadena de Markov: dado el último sorteo, predice los números más probables para el siguiente. P3/P4 · Día/Noche",
  },
  {
    id: "trend_momentum",
    label: "Momentum de Tendencia",
    description:
      "Detecta números en alza/baja comparando frecuencia reciente (últimos 30 sorteos) vs histórica total. P3/P4 · Día/Noche",
  },
  {
    id: "positional_analysis",
    label: "Análisis Posicional",
    description:
      "P3: centena/decena/unidad por posición. P4: pares [AB][CD] con decena y unidad de cada par. Frecuencia + gap por posición.",
  },
  {
    id: "est_individuales",
    label: "Est. Individuales (Hot)",
    description:
      "Top 10 números 00-99 más calientes: los más cerca de su máximo histórico sin salir. Solo P3 (Fijo).",
    createdBy: 728711697,
  },
  // —— Nuevas estrategias (v2) ——
  {
    id: "markov_order2",
    label: "Markov Orden 2",
    description:
      "Cadena de Markov de segundo orden: dado el par (penúltimo → último sorteo), predice el siguiente. Captura dependencias de dos pasos que Markov-1 no puede detectar. P3/P4 · Día/Noche",
    createdBy: 728711697,
  },
  {
    id: "decade_family",
    label: "Familias de Decenas",
    description:
      "Agrupa los 100 números en 10 familias (D0=00-09, D1=10-19, …, D9=90-99). Identifica la familia con mayor momentum reciente y la más debida, luego proyecta los candidatos internos de cada familia candidata. P3/P4 · Día/Noche",
    createdBy: 728711697,
  },
  {
    id: "mirror_complement",
    label: "Espejo y Complemento",
    description:
      "Estudia correlaciones entre un número y sus variantes simétricas: espejo (47↔74), complemento a 99 (23↔76) y complemento a 100 (23↔77). Dado el último sorteo, proyecta los simétricos con mayor probabilidad condicional histórica. P3/P4 · Día/Noche",
    createdBy: 728711697,
  },
  {
    id: "terminal_analysis",
    label: "Análisis de Terminales",
    description:
      "Analiza el dígito de unidad (terminal 0-9) de los números sorteados. Identifica qué terminales están en alza (momentum) o atrasados (due) y proyecta los candidatos completos (00-99) que contienen ese terminal. P3/P4 · Día/Noche",
    createdBy: 728711697,
  },
  {
    id: "cycle_detector",
    label: "Detector de Ciclos",
    description:
      "Detecta si un número tiene un ciclo de aparición predominante (cada N sorteos). Calcula la fase actual: fase ≈ 1.0 = el ciclo dice que toca ahora. Trabaja en conteo de sorteos (no días) para mayor precisión. P3/P4 · Día/Noche",
    createdBy: 728711697,
  },
  {
    id: "streak_analysis",
    label: "Análisis de Rachas",
    description:
      "Analiza rachas calientes (sorteos consecutivos apareciendo) y frías (ausencias consecutivas). Detecta inercia activa y presión acumulada. Diferencia clave vs Momentum: trabaja en sorteos consecutivos y analiza continuidad, no solo ratio de frecuencia. P3/P4 · Día/Noche",
    createdBy: 728711697,
  },
  {
    id: "bayesian_score",
    label: "Score Bayesiano",
    description:
      "Combina 6 señales estadísticas (Frecuencia 15%, Gap 20%, Momentum 20%, Ciclo 15%, Markov 20%, Racha 10%) en un score continuo 0-100. Ventaja vs Consenso: score cuantitativo (no votación binaria) con mayor capacidad discriminatoria entre candidatos. P3/P4 · Día/Noche",
    createdBy: 728711697,
  },
  {
    id: "unodostres",
    label: "Resonancia Fibonacci (1-2-3)",
    description:
      "Proyecta ventanas de alta probabilidad usando la serie Fibonacci como estructura temporal. Un número está en resonancia si lleva exactamente Fₙ = {1,2,3,5,8,13,21,34,55,89,144} días sin salir desde su última aparición. Ciclo mayor (F34+) = pico máximo. P3/P4 · Día/Noche",
    createdBy: 728711697,
  },
  {
    id: "unodostres_plus",
    label: "UNODOSTRES+ (Finobacci Plus)",
    description:
      "Garantiza Resonancia Fibonacci mejorada y simplificada visualmente. Detecta números en su pico cíclico. Permite Top 10, 20 o 30. Muestra candidatos en fases de alerta (Mayor, Expansión, Corto Plazo). P3/P4 · Día/Noche",
    createdBy: 728711697,
  },

  {
    id: "consensus_multi",
    label: "Consenso Multi-Estrategia",
    description:
      "Cruza los candidatos de varias estrategias y devuelve los N números con mayor respaldo estadístico cruzado.",
  },
];

/** Índice O(1) para obtener el label de cualquier estrategia por id. */
const STRATEGY_LABEL_BY_ID = new Map(BUILT_IN_STRATEGIES.map((s) => [s.id, s.label]));

/**
 * IDs de los menús "integrados" (no están en customMenus / Sheet de Estrategias,
 * se registran vía registerExtraMenus) pero que también deben aparecer
 * asignados al dueño en la columna menus del Sheet.
 * Nota: est_individuales fue migrado a BUILT_IN_STRATEGIES (tiene StrategyDefinition completa).
 */
const PLAN_MENU_IDS = ["est_grupos"] as const;

/**
 * Siembra las estrategias built-in que no estén aún en el catálogo y las asigna
 * al dueño del bot respetando cambios manuales en el Sheet.
 *
 * Reglas de asignación al dueño:
 *  - PLAN_MENU_IDS (est_grupos): siempre se añaden si faltan.
 *    Son menús base del sistema, no gestionables desde el catálogo.
 *  - BUILT_IN_STRATEGIES: solo se añaden al dueño si son NUEVAS en este arranque
 *    (acaban de añadirse al catálogo). Si ya existían en el catálogo pero el dueño
 *    las quitó manualmente del Sheet, ese cambio se respeta y no se revierten.
 *  - La carga previa desde el Sheet en initUserConfig() ya reflejó el estado actual
 *    del dueño; aquí solo completamos lo genuinamente nuevo.
 */
async function seedBuiltInStrategies(ownerIds: number[]): Promise<void> {
  // newIds = IDs que NO estaban en el catálogo y se acaban de insertar ahora.
  const newIds = seedCustomMenus(BUILT_IN_STRATEGIES);
  if (newIds.length > 0) {
    console.log(`[seed] ${newIds.length} estrategia(s) nueva(s) en catálogo: ${newIds.join(", ")}`);
  }

  if (ownerIds.length === 0) {
    console.warn("[seed] BOT_OWNER_ID no definido; no se asignan estrategias al dueño.");
    return;
  }

  for (const ownerId of ownerIds) {
    const current = getUserAssignedMenuIds(ownerId);

    // Candidatos a añadir al dueño:
    //  · Estrategias recién creadas en el catálogo (genuinamente nuevas para este arranque)
    //  · PLAN_MENU_IDS que no tenga aún (son intransferibles al catálogo)
    const toAdd = [
      ...newIds,
      ...(PLAN_MENU_IDS as readonly string[]),
    ].filter((id) => !current.includes(id));

    if (toAdd.length === 0) continue;

    await addAllowed(ownerId);
    await setExtraMenus(ownerId, [...current, ...toAdd]);
    console.log(
      `[seed] ${toAdd.length} estrategia(s) añadida(s) al dueño (userId=${ownerId}): ${toAdd.join(", ")}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────

const bot = new Bot(BOT_TOKEN);

bot.use(
  createRestrictMiddleware({
    getOwnerId,
    isAllowed,
    requestAccessLink: REQUEST_ACCESS_LINK,
    buildMainKeyboard: buildMainKb,
    addPlanRequest,
    isOwner,
    getOnboardingPhoto: () => {
      if (onboardingPhotoFileId) return onboardingPhotoFileId;
      if (existsSync(ONBOARDING_IMAGE_PATH)) {
        return new InputFile(ONBOARDING_IMAGE_PATH);
      }
      console.error("[bot] Onboarding image not found at:", ONBOARDING_IMAGE_PATH);
      return undefined;
    },
    onOnboardingPhotoSent: (fileId: string) => {
      onboardingPhotoFileId = fileId;
    },
    reloadPlans: reloadPlansIfStale,
  })
);

import { buildRecentDrawsDisplay } from "./recent-draws.js";

bot.command("start", async (ctx) => {
  await reloadConfigFromStorage();
  const startUserId = ctx.from?.id;
  let announcementBanner = "";
  if (startUserId && !isOwner(startUserId)) {
    const annItems = await loadAnnouncementsFromDB();
    const { buildAnnouncementsBanner } = await import("./announcements.js");
    announcementBanner = buildAnnouncementsBanner(annItems);
  }

  // Banner de registro para usuarios no registrados
  let registrationBanner = "";
  if (startUserId && !isOwner(startUserId) && !isRegistered(startUserId)) {
    registrationBanner = "📢 *¡Bienvenido a Ball Bot!*\n" +
      "Regístrate compartiendo tu contacto para acceder a todas las funciones.\n" +
      "Pulsa el botón 📞 *Registrarme* abajo.\n\n";
  }

  const [p3, p4] = await Promise.all([getP3Map(), getP4Map()]);
  const { getHoyResult } = await import("./hoy-results.js");
  const recentDrawsText = buildRecentDrawsDisplay(p3, p4, getTodayFloridaMMDDYY(), getYesterdayFloridaMMDDYY(), getHoyResult());

  await ctx.reply(
    registrationBanner + announcementBanner + buildMainMenuMessage(ctx.from?.first_name || "Usuario", recentDrawsText),
    { parse_mode: "Markdown", reply_markup: buildMainKb(startUserId) }
  );
});

bot.command("help", async (ctx) => {
  await reloadConfigFromStorage();
  const userId = ctx.from?.id;
  const planName = (userId !== undefined ? getPlan(userId) : undefined) ?? "Básico";
  const kb = buildMainKb(userId);
  const ownerId = getOwnerId();
  if (ownerId) {
    kb.row().url("📩 Contactar al administrador", `tg://user?id=${ownerId}`);
  }
  await ctx.reply(buildHelpText(planName), { parse_mode: "Markdown", reply_markup: kb });
});

bot.command("admin", async (ctx) => {
  if (!isOwner(ctx.from?.id ?? 0)) return;
  await ctx.reply(
    "⚙️ *Panel de Administración*\n\n" +
    "Centro de control completo del bot. Todo lo que puedes hacer desde aquí:\n\n" +
    "👥 *Usuarios* — Lista todos los usuarios con acceso, consulta su plan, estado y datos de contacto.\n\n" +
    "➕➖ *Acceso* — Agrega o elimina usuarios de la lista de acceso permitido.\n\n" +
    "📋 *Estrategias por usuario* — Asigna o quita estrategias individuales a cualquier usuario.\n\n" +
    "🤖 *Gestionar Estrategias* — Crea nuevas estrategias personalizadas, elimínalas, controla su visibilidad pública/privada y revisa las solicitudes de acceso pendientes.\n\n" +
    "💰 *Gestionar Planes* — Crea, edita y elimina planes de suscripción; asigna planes a usuarios; revisa y aprueba solicitudes de cambio de plan.", {
    parse_mode: "Markdown",
    reply_markup: buildSecurityKeyboard(),
  });
});

bot.command("gemini_modelos", async (ctx) => {
  if (!isOwner(ctx.from?.id ?? 0)) return;
  const msg = await ctx.reply("⏳ Consultando modelos disponibles en tu API key...");
  try {
    const modelos = await listarModelosGemini();
    if (modelos.length === 0) {
      await ctx.api.editMessageText(
        msg.chat.id, msg.message_id,
        "⚠️ No se encontraron modelos que soporten `generateContent` con esta API key.",
        { parse_mode: "Markdown" }
      );
      return;
    }
    const lista = modelos.map((m) => `• \`${m}\``).join("\n");
    await ctx.api.editMessageText(
      msg.chat.id, msg.message_id,
      `🤖 *Modelos Gemini disponibles (${modelos.length}):*\n\n${lista}\n\n` +
      `_Copia uno de estos nombres y actualiza_ \`GEMINI_MODELS\` _en_ \`src/adivinanza.ts\`_._`,
      { parse_mode: "Markdown" }
    );
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    await ctx.api.editMessageText(
      msg.chat.id, msg.message_id,
      `❌ *Error al listar modelos:*\n\n\`${detail}\``,
      { parse_mode: "Markdown" }
    );
  }
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  let result: string;
  let keyboard: InlineKeyboard = buildMainKb(ctx.from?.id);

  // ── hit webhook publicar ─────────────────────────────────────────────────
  if (data.startsWith("hit_pub_")) {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (userId && !isOwner(userId)) return;

    if (!ctx.callbackQuery.message || !ctx.chat) return;

    const msgId = ctx.callbackQuery.message.message_id;
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
    await ctx.api.sendMessage(userId!, "✅ *Sorteo publicado a todos los usuarios.*", { parse_mode: "Markdown", reply_markup: buildMainKb(userId) }).catch(() => { });

    const allowed = getAllowedUsers();
    let sentCount = 0;
    for (const uid of allowed) {
      if (uid === userId) continue;
      try {
        await ctx.api.copyMessage(uid, ctx.chat.id, msgId, {
          reply_markup: buildMainKb(uid),
        });
        sentCount++;
      } catch (e) {
        // Ignorar
      }
    }
    console.log(`[HIT WEBHOOK] Publicado a ${sentCount} usuarios por admin ${userId}.`);
    return;
  }
  const asyncData =
    /^(fijo|corrido|ambos)_(hoy|ayer|semana)$/.test(data) ||
    data === "stats_grupos_M" ||
    data === "stats_grupos_E" ||
    data === "stats_individual_M" ||
    data === "stats_individual_E" ||
    (data.startsWith(EXTRA_MENU_CALLBACK_PREFIX) && !!getHandler(data.slice(EXTRA_MENU_CALLBACK_PREFIX.length)));

  if ((data === "security_open" || data === "security_main" || (data.startsWith("admin_") && !data.startsWith("admin_sugerencia") && !data.startsWith("admin_ann"))) && ctx.from && isOwner(ctx.from.id)) {
    const out = await handleSecurityCallback(ctx, data, {
      buildMainKeyboard: buildMainKb,
      getExtraMenuIds,
      getExtraMenuLabel,
      getStorageBackend,
      loadPlansFromDB,
      initPlansFromDB,
      getP3Map,
      getP4Map,
      getTodayFloridaMMDDYY,
      getYesterdayFloridaMMDDYY,
    });
    if (out) {
      try {
        await ctx.editMessageText(out.result, { parse_mode: "Markdown", reply_markup: out.keyboard });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }
  }

  // ── Testing (solo dueño) ──────────────────────────────────────────────────
  if ((data === "testing_open" || data === "testing_cambiar" || data === "testing_eliminar") && ctx.from && isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery();
    const userId = ctx.from.id;

    if (data === "testing_open") {
      const current = await loadTestingCutoffDate(userId);
      try {
        await ctx.editMessageText(buildTestingMessage(current), {
          parse_mode: "Markdown",
          reply_markup: buildTestingKeyboard(current),
        });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    if (data === "testing_cambiar") {
      waitingTestingDate.set(userId, true);
      try {
        await ctx.editMessageText(
          "🧪 *Modo Testing — Cambiar fecha*\n\n" +
          "Escribe la fecha de corte en formato *MM/DD/YY* \\(ej: `12/31/25`\\)\\.\n\n" +
          "_Las estrategias usarán solo sorteos hasta esa fecha\\._\n\n" +
          "Usa /cancel para cancelar\\.",
          {
            parse_mode: "MarkdownV2",
            reply_markup: new InlineKeyboard().text("❌ Cancelar", "testing_cancel"),
          }
        );
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    if (data === "testing_eliminar") {
      try {
        await saveTestingCutoffDate(null, userId);
        invalidateTestingCutoffCache(userId);
        await ctx.editMessageText(
          buildTestingMessage(null),
          { parse_mode: "Markdown", reply_markup: buildTestingKeyboard(null) }
        );
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
        await ctx.reply("❌ Error al eliminar la fecha. Revisa los logs.", {
          reply_markup: buildMainKb(userId),
        });
      }
      return;
    }
  }

  if (data === "testing_cancel" && ctx.from && isOwner(ctx.from.id)) {
    const userId = ctx.from.id;
    waitingTestingDate.delete(userId);
    await ctx.answerCallbackQuery({ text: "Cancelado" });
    const current = await loadTestingCutoffDate(userId);
    try {
      await ctx.editMessageText(buildTestingMessage(current), {
        parse_mode: "Markdown",
        reply_markup: buildTestingKeyboard(current),
      });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }
  // ── fin Testing ───────────────────────────────────────────────────────────

  // ── Sugerencia (usuarios y admin) ──────────────────────────────────────────
  if (data === "sugerencia_open") {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(
        "💬 *Sugerencia*\n\nAquí puedes enviarnos tu opinión, sugerencia o comentario.\n\n" +
        "_Tu mensaje llegará directamente al administrador._",
        { parse_mode: "Markdown", reply_markup: buildSugerenciaKeyboard() }
      );
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  if (data === "sugerencia_enviar") {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    waitingSugerenciaText.set(userId, true);
    try {
      await ctx.editMessageText(
        "✉️ *Enviar sugerencia*\n\nEscribe tu mensaje _(máx. 500 caracteres)_:\n\n_Pulsa Cancelar o /cancel para salir._",
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("❌ Cancelar", "sugerencia_cancel"),
        }
      );
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  if (data === "sugerencia_cancel") {
    await ctx.answerCallbackQuery({ text: "Cancelado" });
    const userId = ctx.from?.id;
    if (userId) waitingSugerenciaText.delete(userId);
    try {
      await ctx.editMessageText(
        "💬 *Sugerencia*\n\nAquí puedes enviarnos tu opinión, sugerencia o comentario.",
        { parse_mode: "Markdown", reply_markup: buildSugerenciaKeyboard() }
      );
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  // Paginación de "Mis sugerencias" (usuario normal)
  if (data.startsWith("sugerencia_mis_p:")) {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;
    const page = parseInt(data.replace("sugerencia_mis_p:", ""), 10) || 0;
    try {
      const sugerencias = await getSugerenciaForUser(userId);
      const { buildMySugerenciasMessage } = await import("./sugerencia.js");
      const { text, totalPages } = buildMySugerenciasMessage(sugerencias, page);
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: buildMySugerenciasKeyboard(page, totalPages),
      });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  // ── Sugerencia admin: lista paginada de usuarios ────────────────────────────
  if (data === "admin_sugerencia_open" || data.startsWith("admin_sugerencia_p:")) {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Sin acceso" });
      return;
    }
    await ctx.answerCallbackQuery();
    const page = data.startsWith("admin_sugerencia_p:")
      ? (parseInt(data.replace("admin_sugerencia_p:", ""), 10) || 0)
      : 0;
    try {
      const allSugerencias = await loadSugerenciasFromDB();
      const { groupSugerenciaByUser, buildAdminSugerenciaListMessage, SUGERENCIA_PAGE_SIZE } = await import("./sugerencia.js");
      const grouped = groupSugerenciaByUser(allSugerencias);
      const { text, totalPages } = buildAdminSugerenciaListMessage(grouped, page);
      const safePage = Math.max(0, Math.min(page, totalPages - 1));
      const slice = grouped.slice(safePage * SUGERENCIA_PAGE_SIZE, (safePage + 1) * SUGERENCIA_PAGE_SIZE);
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: buildAdminSugerenciaListKeyboard(safePage, totalPages, slice),
      });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  // ── Sugerencia admin: mensajes de un usuario específico ────────────────────
  if (data.startsWith("admin_sugerencia_user:")) {
    if (!ctx.from || !isOwner(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Sin acceso" });
      return;
    }
    await ctx.answerCallbackQuery();
    // Formato: admin_sugerencia_user:<userId>_p:<page>
    const match = data.match(/^admin_sugerencia_user:(\d+)_p:(\d+)$/);
    if (!match) return;
    const targetUserId = parseInt(match[1]!, 10);
    const page = parseInt(match[2]!, 10) || 0;
    try {
      const sugerencias = await getSugerenciaForUser(targetUserId);
      const { buildAdminUserSugerenciaMessage } = await import("./sugerencia.js");
      const { text, totalPages } = buildAdminUserSugerenciaMessage(sugerencias, targetUserId, page);
      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        reply_markup: buildAdminUserSugerenciaKeyboard(targetUserId, page, totalPages),
      });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }
  // ── fin Sugerencia ──────────────────────────────────────────────────────────

  // ── Anuncios Globales (admin) ────────────────────────────────────────
  if (data === "admin_ann_open" || data === "admin_ann_refresh") {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Sin acceso" }); return; }
    await ctx.answerCallbackQuery();
    try {
      const { buildAdminAnnouncementsKeyboard, buildAdminAnnouncementsText } = await import("./announcements.js");
      const items = await loadAnnouncementsFromDB(true);
      await ctx.editMessageText(buildAdminAnnouncementsText(items), {
        parse_mode: "Markdown",
        reply_markup: buildAdminAnnouncementsKeyboard(items.length > 0),
      });
    } catch (e) { if (!(e as Error).message?.includes("message is not modified")) console.error(e); }
    return;
  }

  if (data === "admin_ann_create") {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Sin acceso" }); return; }
    await ctx.answerCallbackQuery();
    waitingAnnouncementInput.set(ctx.from.id, "create");
    try {
      await ctx.editMessageText(
        "📢 *Nuevo anuncio*\n\nEscribe el texto del anuncio _(máx. 300 caracteres)_:\n\n_Pulsa Cancelar o /cancel para salir._",
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("❌ Cancelar", "admin_ann_open") }
      );
    } catch (e) { if (!(e as Error).message?.includes("message is not modified")) console.error(e); }
    return;
  }

  if (data === "admin_ann_edit_list") {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Sin acceso" }); return; }
    await ctx.answerCallbackQuery();
    try {
      const { buildAnnouncementsEditListKeyboard } = await import("./announcements.js");
      const items = await loadAnnouncementsFromDB(true);
      await ctx.editMessageText(
        items.length === 0
          ? "❌ No hay anuncios que editar."
          : "✏️ *Editar anuncio*\n\nElige el anuncio a editar:",
        {
          parse_mode: "Markdown",
          reply_markup: items.length > 0 ? buildAnnouncementsEditListKeyboard(items) : new InlineKeyboard().text("◀️ Volver", "admin_ann_open"),
        }
      );
    } catch (e) { if (!(e as Error).message?.includes("message is not modified")) console.error(e); }
    return;
  }

  if (data.startsWith("admin_ann_edit_pick:")) {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Sin acceso" }); return; }
    await ctx.answerCallbackQuery();
    const annId = data.replace("admin_ann_edit_pick:", "");
    waitingAnnouncementInput.set(ctx.from.id, `edit:${annId}`);
    try {
      const items = await loadAnnouncementsFromDB();
      const ann = items.find((a) => a.id === annId);
      await ctx.editMessageText(
        `✏️ *Editar anuncio*\n\n_Texto actual:_\n${ann?.texto ?? "(no encontrado)"}\n\nEscribe el *nuevo texto*:`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("❌ Cancelar", "admin_ann_open") }
      );
    } catch (e) { if (!(e as Error).message?.includes("message is not modified")) console.error(e); }
    return;
  }

  if (data === "admin_ann_delete_list") {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Sin acceso" }); return; }
    await ctx.answerCallbackQuery();
    try {
      const { buildAnnouncementsDeleteListKeyboard } = await import("./announcements.js");
      const items = await loadAnnouncementsFromDB(true);
      await ctx.editMessageText(
        items.length === 0 ? "❌ No hay anuncios que eliminar." : "🗑 *Eliminar anuncio*\n\nElige el anuncio a eliminar:",
        {
          parse_mode: "Markdown",
          reply_markup: items.length > 0 ? buildAnnouncementsDeleteListKeyboard(items) : new InlineKeyboard().text("◀️ Volver", "admin_ann_open"),
        }
      );
    } catch (e) { if (!(e as Error).message?.includes("message is not modified")) console.error(e); }
    return;
  }

  if (data.startsWith("admin_ann_delete_pick:")) {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Sin acceso" }); return; }
    await ctx.answerCallbackQuery();
    const annId = data.replace("admin_ann_delete_pick:", "");
    try {
      const items = await loadAnnouncementsFromDB();
      const ann = items.find((a) => a.id === annId);
      await ctx.editMessageText(
        `🗑 ¿Eliminar este anuncio?\n\n_${ann?.texto ?? "(no encontrado)"}_`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("✅ Sí, eliminar", `admin_ann_delete_confirm:${annId}`)
            .text("❌ No", "admin_ann_delete_list"),
        }
      );
    } catch (e) { if (!(e as Error).message?.includes("message is not modified")) console.error(e); }
    return;
  }

  if (data.startsWith("admin_ann_delete_confirm:")) {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Sin acceso" }); return; }
    await ctx.answerCallbackQuery();
    const annId = data.replace("admin_ann_delete_confirm:", "");
    try {
      const { buildAdminAnnouncementsKeyboard, buildAdminAnnouncementsText } = await import("./announcements.js");
      const updated = await deleteAnnouncement(annId);
      const items = updated ?? await loadAnnouncementsFromDB(true);
      invalidateAnnouncementsCache();
      await ctx.editMessageText(
        (updated ? "✅ Anuncio eliminado.\n\n" : "❌ No se encontró el anuncio.\n\n") + buildAdminAnnouncementsText(items),
        { parse_mode: "Markdown", reply_markup: buildAdminAnnouncementsKeyboard(items.length > 0) }
      );
    } catch (e) { if (!(e as Error).message?.includes("message is not modified")) console.error(e); }
    return;
  }

  if (data === "admin_ann_clear_confirm") {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Sin acceso" }); return; }
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(
        "🧹 ¿Eliminar *todos* los anuncios?\n\n_Esta acción no se puede deshacer._",
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("✅ Sí, limpiar todo", "admin_ann_clear_execute")
            .text("❌ No", "admin_ann_open"),
        }
      );
    } catch (e) { if (!(e as Error).message?.includes("message is not modified")) console.error(e); }
    return;
  }

  if (data === "admin_ann_clear_execute") {
    if (!ctx.from || !isOwner(ctx.from.id)) { await ctx.answerCallbackQuery({ text: "Sin acceso" }); return; }
    await ctx.answerCallbackQuery();
    try {
      const { buildAdminAnnouncementsKeyboard, buildAdminAnnouncementsText } = await import("./announcements.js");
      await clearAllAnnouncements();
      invalidateAnnouncementsCache();
      await ctx.editMessageText("✅ Todos los anuncios eliminados.\n\n" + buildAdminAnnouncementsText([]),
        { parse_mode: "Markdown", reply_markup: buildAdminAnnouncementsKeyboard(false) }
      );
    } catch (e) { if (!(e as Error).message?.includes("message is not modified")) console.error(e); }
    return;
  }
  // ── fin Anuncios ──────────────────────────────────────────────────────────

  // ── Crear Adivinanza (solo dueño) ─────────────────────────────────────────
  if (
    (data === ADIVINANZA_OPEN_CB ||
      data === ADIVINANZA_INGRESAR_CB ||
      data === ADIVINANZA_REGEN_CB) &&
    ctx.from &&
    isOwner(ctx.from.id)
  ) {
    await ctx.answerCallbackQuery();
    const ownerId = ctx.from.id;

    if (data === ADIVINANZA_OPEN_CB) {
      try {
        await ctx.editMessageText(ADIVINANZA_OPEN_MSG, {
          parse_mode: "MarkdownV2",
          reply_markup: buildAdivinanzaMenuKeyboard(),
        });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    if (data === ADIVINANZA_INGRESAR_CB) {
      waitingAdivinanzaNums.set(ownerId, true);
      try {
        await ctx.editMessageText(
          "🔮 *Crear Adivinanza — Ingresar números*\n\n" +
          "Escribe la lista de números separados por espacios o comas\\.\n\n" +
          "Ejemplo: `7 23 45 12 9` o `07, 23, 45`\n\n" +
          "_Máximo 20 números\\. Usa /cancel para cancelar\\._",
          {
            parse_mode: "MarkdownV2",
            reply_markup: new InlineKeyboard().text("❌ Cancelar", ADIVINANZA_OPEN_CB),
          }
        );
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    if (data === ADIVINANZA_REGEN_CB) {
      const numbers = adivinanzaLastNums.get(ownerId);
      if (!numbers || numbers.length === 0) {
        await ctx.answerCallbackQuery({ text: "⚠️ No hay números en caché. Genera una adivinanza primero." });
        return;
      }
      try {
        await ctx.editMessageText(
          "⏳ _Generando adivinanza\\.\\.\\._",
          { parse_mode: "MarkdownV2", reply_markup: new InlineKeyboard() }
        );
        const texto = await generarAdivinanza(numbers);
        const msg = buildAdivinanzaResultMsg(texto, numbers);
        await ctx.editMessageText(msg, {
          parse_mode: "Markdown",
          reply_markup: buildAdivinanzaResultKeyboard(),
        });
      } catch (err) {
        console.error("[adivinanza] Error al regenerar:", err);
        const detail = err instanceof Error ? err.message : String(err);
        try {
          await ctx.editMessageText(
            `❌ *Error al regenerar*\n\n\`${detail}\``,
            { parse_mode: "Markdown", reply_markup: buildAdivinanzaMenuKeyboard() }
          );
        } catch { /* ignorar si el mensaje ya fue editado */ }
      }
      return;
    }
  }
  // ── fin Crear Adivinanza ──────────────────────────────────────────────────

  if (data === ESTRATEGIAS_OPEN_CALLBACK) {
    await ctx.answerCallbackQuery();
    // Siempre recarga desde el Sheet antes de mostrar el menú para que refleje
    // exactamente las estrategias asignadas al usuario (especialmente al dueño).
    await reloadConfigFromStorage();
    const result = "➕ *Estrategias*\n\nElige una estrategia o gestiona las tuyas:";
    const keyboard = buildEstrategiasKeyboard(ctx.from?.id, mainKbDeps, getUserTopN(ctx.from?.id ?? 0));
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  if (data === "mi_link_open") {
    await ctx.answerCallbackQuery();
    const uid = ctx.from?.id;
    if (!uid) return;

    if (!process.env.DATABASE_URL) {
      await ctx.reply("🔗 *Sistema de Referidos*\n\n_El sistema se está actualizando y estará disponible pronto._", { parse_mode: "Markdown", reply_markup: buildMainKb(uid) });
      return;
    }

    const botInfo = await ctx.api.getMe();
    const link = `https://t.me/${botInfo.username}?start=ref_${uid}`;

    const msg = `🔗 *Tu Enlace de Referido VIP*\n\n` +
      `Comparte este enlace con tus amigos:\n\`${link}\`\n\n` +
      `🎁 *Recompensa:* Si un amigo se registra usando tu enlace y luego adquiere un plan, **tú recibirás 1 MES GRATIS de Plan Pro** de forma automática.\n\n` +
      `_¡Mientras más recomiendas, más juegas gratis!_`;

    try {
      await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("◀️ Volver", "volver") });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }


  if (ctx.from && isAllowed(ctx.from.id) && (data === "estrategias_manage" || data === "estrategias_list" || data === "estrategias_tienda" || data.startsWith("estrategias_request_") || data.startsWith("estrategias_confirm_request_") || data === "estrategias_visibility" || data.startsWith("estrategias_visibility_toggle_") || data === "estrategias_create" || data === "estrategias_delete" || data.startsWith("estrategias_delete_"))) {
    const estrategiasOut = await handleEstrategiasUserCallback(ctx, data, {
      getExtraMenuIds,
      getExtraMenuLabel,
      getExtraMenus,
      getUserAssignedMenuIds,
      getPlan,
      getPlanByTitle,
      getMenuCreatedBy,
      getOwnerId,
      isOwner,
      buildMainKeyboard: buildMainKb,
      reloadStrategies: reloadStrategiesIfStale,
      hasPreviewedStrategy,
    });
    if (estrategiasOut) {
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText(estrategiasOut.result, {
          parse_mode: "Markdown",
          reply_markup: estrategiasOut.keyboard,
        });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }
  }

  if (data === "cambiar_plan_open" && ctx.from && isAllowed(ctx.from.id) && !isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery();
    const plans = getPlans().filter((p) => !p.autoApprove);
    if (plans.length === 0) {
      try {
        await ctx.editMessageText("No hay planes disponibles para cambiar.", {
          parse_mode: "Markdown",
          reply_markup: buildMainKb(ctx.from?.id),
        });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }
    const currentPlan = getPlan(ctx.from.id);
    const currentTemporality = getPlanTemporality(ctx.from.id);
    const currentExpiry = getPlanExpiry(ctx.from.id);
    const pendingTitle = getPendingPlanTitle(ctx.from.id);
    const pendingTemp = getPendingPlanTemporality(ctx.from.id);
    let headerMsg = "📋 *Cambiar de plan*\n\n";
    if (pendingTitle) {
      const tPendLabel = pendingTemp ? ` (${TEMPORALITIES.find((t) => t.id === pendingTemp)?.label ?? pendingTemp})` : "";
      headerMsg += `Solicitud pendiente: *${escapeMd(pendingTitle)}*${tPendLabel}. Puedes reemplazarla eligiendo otra opción.\n\n`;
    } else if (currentPlan) {
      const tCurLabel = currentTemporality ? ` (${TEMPORALITIES.find((t) => t.id === currentTemporality)?.label ?? currentTemporality})` : "";
      const expiryInfo = currentExpiry ? ` · caduca: ${currentExpiry}` : "";
      headerMsg += `Plan actual: *${escapeMd(currentPlan)}*${tCurLabel}${expiryInfo}\n\n`;
    }
    headerMsg += "_Tu acceso actual se mantiene hasta que el administrador apruebe el cambio._";
    const keyboard = new InlineKeyboard();
    for (const p of plans) {
      keyboard.text(`📋 ${p.title}`, `noop_cambiar`).row();
      const temps = TEMPORALITIES.filter((t) => t.id !== "7d");
      for (let i = 0; i < temps.length; i++) {
        const t = temps[i]!;
        const price = getPriceForTemporality(p, t.id);
        const priceLabel = price ? ` — ${formatPlanPrice(price)}` : "";
        keyboard.text(`${t.label}${priceLabel}`, `user_cambiar_plan_${p.id}_${t.id}`);
        if (i % 2 === 1) keyboard.row();
      }
      if (temps.length % 2 !== 0) keyboard.row();
    }
    keyboard.text("◀️ Cancelar", "volver");
    try {
      await ctx.editMessageText(headerMsg, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  if (data.startsWith("user_cambiar_plan_") && ctx.from && isAllowed(ctx.from.id) && !isOwner(ctx.from.id)) {
    const rest = data.slice("user_cambiar_plan_".length);
    // Format: planId_temporality (temporality is always 2 chars: 1m,3m,6m,1a)
    const lastUnderscore = rest.lastIndexOf("_");
    const planId = lastUnderscore > 0 ? rest.slice(0, lastUnderscore) : rest;
    const temporality = lastUnderscore > 0 ? rest.slice(lastUnderscore + 1) : "";
    const plan = getPlanById(planId);
    if (plan && TEMPORALITIES.some((t) => t.id === temporality)) {
      const currentPlan = getPlan(ctx.from.id);
      const userId = ctx.from.id;
      const res = await requestPlanChange(userId, plan.title, temporality);
      await ctx.answerCallbackQuery({ text: res.ok ? "Solicitud enviada" : "Error" });
      const tLabel = TEMPORALITIES.find((t) => t.id === temporality)?.label ?? temporality;
      const currentPlanNote = currentPlan
        ? `Sigues con tu plan *${escapeMd(currentPlan)}* hasta que el administrador apruebe el cambio.`
        : "_El administrador revisará tu solicitud._";
      if (res.ok) {
        // Notificar a todos los owners con botones inline de aprobar/rechazar
        const username = ctx.from.username ? `@${ctx.from.username}` : (ctx.from.first_name || String(userId));
        const adminMsg = `🔔 *Solicitud de cambio de plan*\n\nUsuario: ${escapeMd(username)} (\`${userId}\`)\nPlan solicitado: *${escapeMd(plan.title)}* (${tLabel})`;
        const adminKb = new InlineKeyboard()
          .text("✅ Aprobar", `admin_plans_approve_${userId}`)
          .text("❌ Rechazar", `admin_plans_reject_${userId}`)
          .row()
          .url("📩 Contactar Usuario", `tg://openmessage?user_id=${userId}`);
        for (const oid of getOwnerIds().filter((id) => id !== userId)) {
          bot.api.sendMessage(oid, adminMsg, { parse_mode: "Markdown", reply_markup: adminKb }).catch(() => { });
        }
      }
      try {
        await ctx.editMessageText(
          `✅ Has solicitado cambiar al plan *${escapeMd(plan.title)}* (${tLabel}).\n\n${currentPlanNote}`,
          { parse_mode: "Markdown", reply_markup: buildMainKb(ctx.from.id) }
        );
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      // Mostrar formas de pago disponibles en un mensaje separado
      try {
        await loadPaymentMethodsFromDB();
        const pms = getPaymentMethods();
        if (pms.length > 0) {
          const pmLines = pms.map((p, i) =>
            `${i + 1}. *${p.description}*\n   💳 \`${p.account}\` · 🌐 ${p.currency}`
          );
          const pmText = `💳 *Formas de pago disponibles:*\n\n` + pmLines.join("\n\n");
          const pmKb = new InlineKeyboard();
          for (const pm of pms) {
            pmKb.copyText(`📋 ${pm.description}`, pm.account).row();
          }
          await ctx.reply(pmText, { parse_mode: "Markdown", reply_markup: pmKb });
        }
      } catch (pmErr) {
        console.error("[cambiar_plan] Error mostrando formas de pago:", pmErr);
      }
    } else {
      await ctx.answerCallbackQuery({ text: "Plan o temporalidad no encontrado" });
    }
    return;
  }

  const menuDeps = {
    ...mainKbDeps,
    buildHelpText,
    reloadUserConfig: reloadConfigFromStorage,
    ownerUserId: getOwnerId() ?? undefined,
    getHotThresholdDays: () => hotThresholdDays,
    setHotThresholdDays: (n: number) => {
      if (n >= 1 && n <= 30) hotThresholdDays = n;
    },
    getStrategiesTopN: () => getUserTopN(0), // legacy — handlers usan userId explícito
    setStrategiesTopN: (_n: number) => { /* no-op legacy */ },
    getP3Map,
    getP4Map,
    buildGroupStatsMessage: buildGroupStatsMessageFromStats,
    buildIndividualTop10Message: buildIndividualTop10MessageFromStats,
    buildResultOneDay,
    buildResultWeek,
    getTodayFloridaMMDDYY,
    getYesterdayFloridaMMDDYY,
    getThisWeekFloridaMMDDYY,
  };

  const menuOut = await handleMenuCallback(ctx, data, menuDeps);
  if (menuOut) {
    await ctx.answerCallbackQuery().catch(() => { });
    try {
      // ── Banner de anuncios (solo usuarios no-admin) ──────────────────────
      let announcementBanner = "";
      const menuUserId = ctx.from?.id;
      if (menuUserId && !isOwner(menuUserId)) {
        const annItems = await loadAnnouncementsFromDB();
        const { buildAnnouncementsBanner } = await import("./announcements.js");
        announcementBanner = buildAnnouncementsBanner(annItems);
      }
      await ctx.editMessageText(announcementBanner + menuOut.result, { parse_mode: "Markdown", reply_markup: menuOut.keyboard });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!msg.includes("message is not modified")) console.error("Error en callback_query:", err);
    }
    return;
  }

  if (data.startsWith(STRATEGY_CONTEXT_CALLBACK_PREFIX)) {
    const parsed = parseStrategyContextCallback(data);
    if (parsed) {
      // ── Gating: bloquear ejecución si el usuario no tiene plan ──
      const stratUserId = ctx.from?.id;
      if (stratUserId && !isOwner(stratUserId) && !hasPlan(stratUserId)) {
        await ctx.answerCallbackQuery();
        const label = getExtraMenuLabel(parsed.menuId) || parsed.menuId;
        const desc = getExtraMenuDescription(parsed.menuId);
        let lockedMsg = `🔒 *${escapeMd(label)}*\n\n`;
        if (desc) lockedMsg += `_${escapeMd(desc)}_\n\n`;
        lockedMsg += "⚠️ Para ver los resultados de esta estrategia debes adquirir un plan.\n\n" +
                     "📋 _Elige un plan para desbloquear todas las estrategias y funciones avanzadas._";
        const lockedKb = new InlineKeyboard()
          .text("📋 Ver Planes", "ver_planes_open").row()
          .text("◀️ Volver a Estrategias", ESTRATEGIAS_OPEN_CALLBACK).row()
          .text("🏠 Volver al Inicio", "volver");
        try {
          await ctx.editMessageText(lockedMsg, { parse_mode: "Markdown", reply_markup: lockedKb });
        } catch (e) {
          if (!(e as Error).message?.includes("message is not modified")) console.error(e);
        }
        return;
      }
      // ── Consenso: flujo interactivo en lugar de ejecución directa ──
      if (parsed.menuId === "consensus_multi") {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (userId) {
          consensusSessionMap.set(userId, {
            context: parsed.context,
            selectedIds: new Set(),
            step: "selecting",
          });
          const selectableIds = getAccessibleStrategyIds(userId);
          const emptySet = new Set<string>();
          const ownerView = isOwner(userId);
          const msg = buildConsensusSelectionMessage(emptySet, parsed.context, selectableIds, ownerView);
          const kb = buildConsensusSelectionKeyboard(emptySet, parsed.context, selectableIds, ownerView);
          try {
            await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
          } catch (e) {
            if (!(e as Error).message?.includes("message is not modified")) console.error(e);
          }
        }
        return;
      }

      if (hasStrategyRunner(parsed.menuId)) {
        if (parsed.menuId === "unodostres_plus") {
          await ctx.answerCallbackQuery();
          const userId = ctx.from?.id;
          if (userId) {
            waitingPlusLimit.set(userId, { menuId: parsed.menuId, context: parsed.context });
            try {
              await ctx.editMessageText(
                `✨ *UnoDosTres+*\n\n` +
                `Has elegido la base de datos y período.\n` +
                `👉 **Escribe la cantidad de candidatos que deseas ver.** (Ej: \`10\`, \`20\`, \`30\`)\n\n` +
                `_/cancel para cancelar._`,
                {
                  parse_mode: "Markdown",
                  reply_markup: new InlineKeyboard().text("❌ Cancelar", "plus_cancel"),
                }
              );
            } catch (e) {
              if (!(e as Error).message?.includes("message is not modified")) console.error(e);
            }
          }
          return;
        }

        await runStrategyAndShowResult(ctx, parsed.menuId, parsed.context);
        return;
      }
    }
  }

  if (data.startsWith(STRATEGY_STORE_PREVIEW_CALLBACK_PREFIX)) {
    const rest = data.slice(STRATEGY_STORE_PREVIEW_CALLBACK_PREFIX.length);
    const parts = rest.split("_");
    if (parts.length >= 3) {
      const mapSource = parts[parts.length - 2];
      const period = parts[parts.length - 1];
      const menuId = parts.slice(0, -2).join("_");
      if ((mapSource === "p3" || mapSource === "p4") && (period === "m" || period === "e")) {
        // Enforce the preview restriction right before running
        if (ctx.from && hasPreviewedStrategy(ctx.from.id, menuId)) {
          await ctx.answerCallbackQuery({ text: "⚠️ Solo puedes ver la previa de una estrategia una sola vez.", show_alert: true });
          return;
        }

        if (menuId === "consensus_multi") {
          await ctx.answerCallbackQuery();
          const userId = ctx.from?.id;
          if (userId) {
            consensusSessionMap.set(userId, {
              context: { mapSource, period } as any,
              selectedIds: new Set(),
              step: "selecting",
              isPreview: true,
            });
            const selectableIds = getAccessibleStrategyIds(userId);
            const emptySet = new Set<string>();
            const ownerView = isOwner(userId);
            const msg = buildConsensusSelectionMessage(emptySet, { mapSource, period } as any, selectableIds, ownerView);
            const kb = buildConsensusSelectionKeyboard(emptySet, { mapSource, period } as any, selectableIds, ownerView, true);
            try {
              await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
            } catch (e) {
              if (!(e as Error).message?.includes("message is not modified")) console.error(e);
            }
          }
          return;
        }

        await runStrategyAndShowResult(ctx, menuId, { mapSource, period } as any, true);

        if (ctx.from) {
          markStrategyAsPreviewed(ctx.from.id, menuId);
        }
        return;
      }
    }
  }

  if (data === "plus_cancel" && ctx.from) {
    waitingPlusLimit.delete(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "Cancelado" });
    try {
      await ctx.editMessageText("Operación cancelada.", { reply_markup: buildMainKb(ctx.from.id) });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  if (data.startsWith("strat_store_preview_")) {
    const menuId = data.replace("strat_store_preview_", "");
    // Check if they have already previewed it before showing context selection
    if (ctx.from && hasPreviewedStrategy(ctx.from.id, menuId)) {
      await ctx.answerCallbackQuery({ text: "⚠️ Solo puedes ver la previa de una estrategia una sola vez.", show_alert: true });
      return;
    }
    await showStrategyContextSelection(ctx, menuId, "store");
    return;
  }

  // ── Análisis Progresivo ────────────────────────────────────────────────────
  if (data.startsWith("prog_") && ctx.from && isOwner(ctx.from.id)) {
    const userId = ctx.from.id;

    // Cancelar en cualquier momento
    if (data === "prog_cancel") {
      progressiveSessionMap.delete(userId);
      waitingProgressiveDate.delete(userId);
      await ctx.answerCallbackQuery({ text: "Cancelado" });
      const current = await loadTestingCutoffDate(userId);
      try {
        await ctx.editMessageText(buildTestingMessage(current), {
          parse_mode: "Markdown",
          reply_markup: buildTestingKeyboard(current),
        });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    // Abrir menú progresivo desde Testing
    if (data === "prog_open") {
      progressiveSessionMap.set(userId, { step: "context", selectedIds: new Set() });
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText(
          `📈 *Análisis Progresivo*\n\n` +
          `_Back-testing iterativo: recorre un rango de fechas y mide cuántas veces cada combinación de estrategias acierta el siguiente sorteo._\n\n` +
          `Elige el tipo de datos a analizar:`,
          { parse_mode: "Markdown", reply_markup: buildProgressiveContextKeyboard() }
        );
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    // Selección de contexto (P3/P4 · M/E)
    if (data.startsWith("prog_ctx_")) {
      const parts = data.slice("prog_ctx_".length).split("_");
      const mapSource = parts[0] as "p3" | "p4";
      const period = parts[1] as "m" | "e";
      if ((mapSource === "p3" || mapSource === "p4") && (period === "m" || period === "e")) {
        const session = progressiveSessionMap.get(userId) ?? { step: "context" as const, selectedIds: new Set<string>() };
        session.context = { mapSource, period };
        session.step = "start_date";
        progressiveSessionMap.set(userId, session);
        waitingProgressiveDate.set(userId, "start");

        const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";
        const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
        await ctx.answerCallbackQuery();
        try {
          await ctx.editMessageText(
            `📈 *Análisis Progresivo* — ${mapLabel} · ${periodLabel}\n\n` +
            `📅 Ingresa la *fecha inicial* (primer corte a analizar).\n` +
            `Formato: \`MM/DD/YY\` _(ej: \`01/01/25\`)_\n\n` +
            `_El análisis usará datos hasta esa fecha inclusive y verificará el siguiente sorteo real._\n\n` +
            `_/cancel para cancelar._`,
            {
              parse_mode: "Markdown",
              reply_markup: new InlineKeyboard().text("❌ Cancelar", "prog_cancel"),
            }
          );
        } catch (e) {
          if (!(e as Error).message?.includes("message is not modified")) console.error(e);
        }
        return;
      }
    }

    // Toggle de estrategia individual
    if (data.startsWith("prog_st_")) {
      const session = progressiveSessionMap.get(userId);
      if (session?.step === "strategies") {
        const stratId = data.slice("prog_st_".length);
        const selectableIds = getAccessibleStrategyIds(userId);
        if (selectableIds.includes(stratId)) {
          if (session.selectedIds.has(stratId)) {
            session.selectedIds.delete(stratId);
          } else {
            session.selectedIds.add(stratId);
          }
          await ctx.answerCallbackQuery();
          const msg = buildProgressiveStrategyMessage(
            session.selectedIds,
            session.context!,
            selectableIds,
            session.startDate!,
            session.endDate!
          );
          const kb = buildProgressiveStrategyKeyboard(session.selectedIds, selectableIds);
          try {
            await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
          } catch (e) {
            if (!(e as Error).message?.includes("message is not modified")) console.error(e);
          }
          return;
        }
      }
    }

    // Cargar grupo predefinido
    if (data.startsWith("prog_g_")) {
      const session = progressiveSessionMap.get(userId);
      if (session?.step === "strategies") {
        const groupId = data.slice("prog_g_".length);
        const group = CONSENSUS_GROUPS.find((g) => g.id === groupId);
        if (group) {
          const selectableIds = getAccessibleStrategyIds(userId);
          const groupSelectable = group.ids.filter((id) => selectableIds.includes(id));
          session.selectedIds = new Set(groupSelectable);
          await ctx.answerCallbackQuery({
            text: `Grupo ${groupId.toUpperCase()} cargado (${groupSelectable.length} estrategias)`,
          });
          const msg = buildProgressiveStrategyMessage(
            session.selectedIds,
            session.context!,
            selectableIds,
            session.startDate!,
            session.endDate!
          );
          const kb = buildProgressiveStrategyKeyboard(session.selectedIds, selectableIds);
          try {
            await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
          } catch (e) {
            if (!(e as Error).message?.includes("message is not modified")) console.error(e);
          }
          return;
        }
      }
    }

    // Seleccionar todas
    if (data === "prog_all") {
      const session = progressiveSessionMap.get(userId);
      if (session?.step === "strategies") {
        const selectableIds = getAccessibleStrategyIds(userId);
        session.selectedIds = new Set(selectableIds);
        await ctx.answerCallbackQuery({ text: `${selectableIds.length} estrategias seleccionadas` });
        const msg = buildProgressiveStrategyMessage(
          session.selectedIds,
          session.context!,
          selectableIds,
          session.startDate!,
          session.endDate!
        );
        const kb = buildProgressiveStrategyKeyboard(session.selectedIds, selectableIds);
        try {
          await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
        } catch (e) {
          if (!(e as Error).message?.includes("message is not modified")) console.error(e);
        }
        return;
      }
    }

    // Limpiar selección
    if (data === "prog_none") {
      const session = progressiveSessionMap.get(userId);
      if (session?.step === "strategies") {
        session.selectedIds = new Set();
        await ctx.answerCallbackQuery({ text: "Selección limpiada" });
        const selectableIds = getAccessibleStrategyIds(userId);
        const msg = buildProgressiveStrategyMessage(
          session.selectedIds,
          session.context!,
          selectableIds,
          session.startDate!,
          session.endDate!
        );
        const kb = buildProgressiveStrategyKeyboard(session.selectedIds, selectableIds);
        try {
          await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
        } catch (e) {
          if (!(e as Error).message?.includes("message is not modified")) console.error(e);
        }
        return;
      }
    }

    // Solicitar ejecución → estima fechas, pide confirmación si es necesario
    if (data === "prog_run" || data === "prog_confirm") {
      const session = progressiveSessionMap.get(userId);
      const validStep = session?.step === "strategies" || session?.step === "confirm";
      if (validStep && session!.context && session!.startDate && session!.endDate) {
        const strategyIds = [...session!.selectedIds];
        if (strategyIds.length < 1) {
          await ctx.answerCallbackQuery({ text: "⚠️ Selecciona al menos 1 estrategia." });
          return;
        }

        // Si venimos de "prog_run" (primer intento), calculamos cuántas fechas hay
        if (data === "prog_run") {
          await ctx.answerCallbackQuery();
          const isP3 = session!.context!.mapSource === "p3";
          const fullMap = isP3 ? await getP3Map() : (await getP4Map()) as DateDrawsMap;
          const estimated = countDatesInRange(
            fullMap, session!.startDate!, session!.endDate!, session!.context!
          );
          session!.estimatedDates = estimated;

          // Si supera el umbral de advertencia, pedimos confirmación
          if (estimated > PROGRESSIVE_WARN_THRESHOLD) {
            const capped = Math.min(estimated, PROGRESSIVE_MAX_DATES);
            const n = Math.min(strategyIds.length, PROGRESSIVE_MAX_STRATEGIES);
            const numCombos = (1 << n) - 1;
            // Tiempo estimado: dominado por getCandidates (N × dates × ~2ms)
            const secsEst = Math.ceil((capped * n * 2) / 1000);
            session!.step = "confirm";
            const mapLabel = session!.context!.mapSource === "p3" ? "P3" : "P4";
            const periodLabel = session!.context!.period === "m" ? "☀️ Mediodía" : "🌙 Noche";
            try {
              await ctx.editMessageText(
                `📈 *Análisis Progresivo* — ${mapLabel} · ${periodLabel}\n\n` +
                `📅 \`${session!.startDate}\` → \`${session!.endDate}\`\n` +
                `🔢 *${estimated}* fechas válidas en el rango` +
                (estimated > PROGRESSIVE_MAX_DATES
                  ? ` _(se analizarán las primeras ${PROGRESSIVE_MAX_DATES})_`
                  : ``) +
                `\n📊 ${n} estrategias · *${numCombos}* combinaciones posibles\n` +
                `⏱ Tiempo estimado: *~${secsEst} seg*\n\n` +
                `¿Confirmas el análisis?`,
                {
                  parse_mode: "Markdown",
                  reply_markup: new InlineKeyboard()
                    .text("✅ Confirmar", "prog_confirm")
                    .text("❌ Cancelar", "prog_cancel"),
                }
              );
            } catch (e) {
              if (!(e as Error).message?.includes("message is not modified")) console.error(e);
            }
            return;
          }
          // Por debajo del umbral: ejecuta directamente (no hace falta cargar fullMap de nuevo)
          // prog_confirm se encargará de la ejecución
          session!.step = "confirm";
          // Fall-through: ejecutar de inmediato enviando la respuesta a prog_confirm
        }

        // Ejecutar (desde prog_confirm o desde prog_run < umbral)
        await ctx.answerCallbackQuery({ text: "Iniciando análisis…" });
        progressiveSessionMap.delete(userId);

        const isP3 = session!.context!.mapSource === "p3";
        const fullMap = isP3 ? await getP3Map() : (await getP4Map()) as DateDrawsMap;
        const estimatedDates = session!.estimatedDates ?? 0;
        const capped = Math.min(estimatedDates || PROGRESSIVE_MAX_DATES, PROGRESSIVE_MAX_DATES);

        const mapLabelShort = session!.context!.mapSource === "p3" ? "P3" : "P4";
        const periodLabelShort = session!.context!.period === "m" ? "☀️" : "🌙";
        const nStrats = Math.min(strategyIds.length, PROGRESSIVE_MAX_STRATEGIES);
        const numCombos = (1 << nStrats) - 1;

        // Mensaje de progreso (editable)
        const progressMsg = await ctx.reply(
          `⏳ *Analizando…* ${mapLabelShort} · ${periodLabelShort}\n\n` +
          `📅 \`${session!.startDate}\` → \`${session!.endDate}\`\n` +
          `🔢 ${capped} fechas · ${nStrats} estrategias · ${numCombos} combinaciones\n\n` +
          `▓░░░░░░░░░  0%`,
          { parse_mode: "Markdown" }
        );

        const chatId = progressMsg.chat.id;
        const msgId = progressMsg.message_id;

        // Barra de progreso 10 bloques
        const bar = (pct: number): string => {
          const filled = Math.floor(pct / 10);
          return "▓".repeat(filled) + "░".repeat(10 - filled) + `  ${pct}%`;
        };

        try {
          const result = await runProgressiveAnalysis({
            startDate: session!.startDate!,
            endDate: session!.endDate!,
            strategyIds,
            context: session!.context!,
            topN: PROGRESSIVE_TOP_N,
            fullMap,
            getStrategy,
            onProgress: async (pct) => {
              try {
                await ctx.api.editMessageText(
                  chatId,
                  msgId,
                  `⏳ *Analizando…* ${mapLabelShort} · ${periodLabelShort}\n\n` +
                  `📅 \`${session!.startDate}\` → \`${session!.endDate}\`\n` +
                  `🔢 ${capped} fechas · ${nStrats} estrategias · ${numCombos} combos\n\n` +
                  `${bar(pct)}`,
                  { parse_mode: "Markdown" }
                );
              } catch { /* ignorar errores de rate limit en actualizaciones de progreso */ }
            },
          });

          const strategyLabels = strategyIds.map((id) => STRATEGY_LABEL_BY_ID.get(id) ?? id);
          const resultMsg = buildProgressiveResultMessage(result, strategyLabels);

          await ctx.api.editMessageText(chatId, msgId, resultMsg, { parse_mode: "Markdown" });

          // ── Exportación JSON crudo para CRM/Dashboard (solo dueños) ──
          if (isOwner(userId)) {
            try {
              const jsonStr = JSON.stringify(result, null, 2);
              const buffer = Buffer.from(jsonStr, "utf-8");
              progressiveResultCache.set(userId, buffer);

              const keyboard = new InlineKeyboard()
                .text("📥 Exportar JSON", "prog_export_json")
                .row();

              await ctx.api.editMessageText(chatId, msgId, resultMsg, {
                parse_mode: "Markdown",
                reply_markup: keyboard
              });
            } catch (jsonErr) {
              console.error("[progressive] Error caching JSON:", jsonErr);
              await ctx.api.editMessageText(chatId, msgId, resultMsg, { parse_mode: "Markdown" });
            }
          } else {
            await ctx.api.editMessageText(chatId, msgId, resultMsg, { parse_mode: "Markdown" });
          }
        } catch (err) {
          console.error("[progressive] Error:", err);
          try {
            await ctx.api.editMessageText(
              chatId, msgId, "❌ Error al ejecutar el análisis progresivo. Revisa los logs."
            );
          } catch { /* ignore */ }
        }
        return;
      }
    }
  }

  // ── BallBackTest (Fusión Dinámica) ──────────────────────────────────────────
  if (data.startsWith("bbt_") && ctx.from && isOwner(ctx.from.id)) {
    const userId = ctx.from.id;

    if (data === "bbt_cancel") {
      bbtSessionMap.delete(userId);
      waitingBBTDate.delete(userId);
      waitingBBTTopN.delete(userId);
      await ctx.answerCallbackQuery({ text: "Cancelado" });
      const current = await loadTestingCutoffDate(userId);
      try {
        await ctx.editMessageText(buildTestingMessage(current), {
          parse_mode: "Markdown",
          reply_markup: buildTestingKeyboard(current),
        });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    if (data === "bbt_open") {
      bbtSessionMap.set(userId, { step: "context", selectedContexts: new Set(), selectedIds: new Set() });
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText(
          `🚀 *BallBackTest — Auditoría Forense*\n\n` +
          `_Crea fusiones dinámicas: múltiples estrategias, rango de fechas extendido y Top N variable._\n\n` +
          `Elige los tipos de datos a analizar (Selección Múltiple):`,
          { parse_mode: "Markdown", reply_markup: buildBBTContextKeyboard(new Set()) }
        );
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    // Selección de contexto (Toggle)
    if (data.startsWith("bbt_ctx_")) {
      const session = bbtSessionMap.get(userId);
      if (!session || session.step !== "context") return;

      if (data === "bbt_ctx_done") {
        if (session.selectedContexts.size === 0) {
          await ctx.answerCallbackQuery({ text: "⚠️ Selecciona al menos un contexto" });
          return;
        }
        session.step = "start_date";
        waitingBBTDate.set(userId, "start");
        await ctx.answerCallbackQuery();
        try {
          await ctx.editMessageText(
            `🚀 *BallBackTest* — ${session.selectedContexts.size} contextos seleccionados\n\n` +
            `📅 Ingresa la *fecha inicial* del análisis.\n` +
            `Formato: \`MM/DD/YY\` _(ej: \`01/01/25\`)_\n\n` +
            `_/cancel para cancelar._`,
            {
              parse_mode: "Markdown",
              reply_markup: new InlineKeyboard().text("❌ Cancelar", "bbt_cancel"),
            }
          );
        } catch (e) {
          if (!(e as Error).message?.includes("message is not modified")) console.error(e);
        }
        return;
      }

      if (data === "bbt_ctx_p3_both") {
        session.selectedContexts.add("p3_m");
        session.selectedContexts.add("p3_e");
      } else if (data === "bbt_ctx_p4_both") {
        session.selectedContexts.add("p4_m");
        session.selectedContexts.add("p4_e");
      } else if (data === "bbt_ctx_all") {
        session.selectedContexts.add("p3_m");
        session.selectedContexts.add("p3_e");
        session.selectedContexts.add("p4_m");
        session.selectedContexts.add("p4_e");
      } else {
        const ctxId = data.slice("bbt_ctx_".length);
        if (session.selectedContexts.has(ctxId)) {
          session.selectedContexts.delete(ctxId);
        } else {
          session.selectedContexts.add(ctxId);
        }
      }
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: buildBBTContextKeyboard(session.selectedContexts)
        });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    // Toggle de estrategia
    if (data.startsWith("bbt_st_")) {
      const session = bbtSessionMap.get(userId);
      if (session?.step === "strategies") {
        const stratId = data.slice("bbt_st_".length);
        const selectableIds = getAccessibleStrategyIds(userId);
        if (selectableIds.includes(stratId)) {
          if (session.selectedIds.has(stratId)) {
            session.selectedIds.delete(stratId);
          } else {
            session.selectedIds.add(stratId);
          }
          await ctx.answerCallbackQuery();
          const contextsArray = bbtContextsFromSet(session.selectedContexts);
          const msg = buildBBTStrategyMessage(
            session.selectedIds,
            contextsArray,
            selectableIds,
            session.startDate!,
            session.endDate!
          );
          const kb = buildBBTStrategyKeyboard(session.selectedIds, selectableIds);
          try {
            await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
          } catch (e) {
            if (!(e as Error).message?.includes("message is not modified")) console.error(e);
          }
          return;
        }
      }
    }

    // Solicitar Top N
    if (data === "bbt_run") {
      const session = bbtSessionMap.get(userId);
      if (session?.step === "strategies") {
        if (session.selectedIds.size === 0) {
          await ctx.answerCallbackQuery({ text: "⚠️ Selecciona al menos 1 estrategia" });
          return;
        }
        session.step = "top_n";
        waitingBBTTopN.add(userId);
        await ctx.answerCallbackQuery();
        try {
          await ctx.editMessageText(
            `🚀 *BallBackTest — Configuración del Top N*\n\n` +
            `¿Cuántos candidatos por sorteo quieres analizar?\n\n` +
            `• Envía un número (ej: \`5\`, \`10\`, \`20\`)\n` +
            `• Envía \`0\` para analizar *TODOS* los candidatos que devuelvan las estrategias.\n\n` +
            `_/cancel para cancelar._`,
            {
              parse_mode: "Markdown",
              reply_markup: new InlineKeyboard().text("❌ Cancelar", "bbt_cancel"),
            }
          );
        } catch (e) {
          if (!(e as Error).message?.includes("message is not modified")) console.error(e);
        }
        return;
      }
    }

    // Confirmación y ejecución
    if (data === "bbt_confirm") {
      const session = bbtSessionMap.get(userId);
      if (session?.step === "confirm" && session.selectedContexts.size > 0 && session.startDate && session.endDate) {
        const strategyIds = [...session.selectedIds];
        const topN = session.topN ?? 0;

        await ctx.answerCallbackQuery({ text: "Iniciando BallBackTest…" });
        bbtSessionMap.delete(userId);

        const contexts = bbtContextsFromSet(session.selectedContexts);

        const hasP3 = contexts.some(c => c.mapSource === "p3");
        const hasP4 = contexts.some(c => c.mapSource === "p4");

        let fullMap: DateDrawsMap = {};
        if (hasP3 && hasP4) {
          const [p3, p4] = await Promise.all([getP3Map(), getP4Map()]);
          const allDates = new Set([...Object.keys(p3), ...Object.keys(p4)]);
          for (const d of allDates) {
            fullMap[d] = { ...(p3[d] || {}), ...(p4[d] || {}) };
          }
        } else if (hasP3) {
          fullMap = await getP3Map();
        } else {
          fullMap = (await getP4Map()) as DateDrawsMap;
        }

        const capped = session.estimatedDates ?? 0;
        const ctxHeader = contexts.map(c =>
          c.params?.ambos
            ? `${c.mapSource.toUpperCase()}A`
            : `${c.mapSource.toUpperCase()}${c.period.toUpperCase()}`
        ).join("+");
        const nStrats = Math.min(strategyIds.length, BBT_MAX_STRATEGIES);
        const numCombos = (1 << nStrats) - 1;

        // Mensaje de progreso
        const progressMsg = await ctx.reply(
          `⏳ *Ejecutando BallBackTest…* [${ctxHeader}]\n\n` +
          `📅 \`${session.startDate}\` → \`${session.endDate}\`\n` +
          `🎯 Top N: ${topN === 0 ? "TODOS" : topN}\n` +
          `🔢 ${capped} fechas · ${nStrats} strats · ${numCombos} combos\n\n` +
          `▓░░░░░░░░░  0%`,
          { parse_mode: "Markdown" }
        );

        const chatId = progressMsg.chat.id;
        const msgId = progressMsg.message_id;

        const bar = (pct: number): string => {
          const filled = Math.floor(pct / 10);
          return "▓".repeat(filled) + "░".repeat(10 - filled) + `  ${pct}%`;
        };

        try {
          const result = await runBallBackTest({
            startDate: session.startDate,
            endDate: session.endDate,
            strategyIds,
            contexts: contexts,
            topN: topN,
            fullMap,
            getStrategy,
            onProgress: async (pct) => {
              try {
                await ctx.api.editMessageText(
                  chatId,
                  msgId,
                  `⏳ *Ejecutando BallBackTest…* [${ctxHeader}]\n\n` +
                  `📅 \`${session.startDate}\` → \`${session.endDate}\`\n` +
                  `🎯 Top N: ${topN === 0 ? "TODOS" : topN}\n\n` +
                  `${bar(pct)}`,
                  { parse_mode: "Markdown" }
                );
              } catch { /* ignore rate limits */ }
            },
          });

          const strategyLabels = strategyIds.map((id) => STRATEGY_LABEL_BY_ID.get(id) ?? id);
          const resultMsg = buildBBTResultMessage(result, strategyLabels);

          // Exportación JSON para BBT
          if (isOwner(userId)) {
            try {
              const jsonStr = JSON.stringify(result, null, 2);
              const buffer = Buffer.from(jsonStr, "utf-8");
              bbtResultCache.set(userId, buffer);

              const keyboard = new InlineKeyboard()
                .text("📥 Exportar JSON (Audit)", "bbt_export_json")
                .row()
                .text("🏠 Inicio", "volver");

              await ctx.api.editMessageText(chatId, msgId, resultMsg, {
                parse_mode: "Markdown",
                reply_markup: keyboard
              });
            } catch (jsonErr) {
              console.error("[bbt] Error caching JSON:", jsonErr);
              await ctx.api.editMessageText(chatId, msgId, resultMsg, { parse_mode: "Markdown" });
            }
          } else {
            await ctx.api.editMessageText(chatId, msgId, resultMsg, { parse_mode: "Markdown" });
          }
        } catch (err) {
          console.error("[bbt] Error:", err);
          try {
            await ctx.api.editMessageText(
              chatId, msgId, "❌ Error al ejecutar BallBackTest. Revisa los logs."
            );
          } catch { /* ignore */ }
        }
        return;
      }
    }
    // ── BBT Compare Mode ─────────────────────────────────────────────────────

    if (data === "bbt_cmp_open") {
      bbtCmpSessionMap.set(userId, {
        step: "strategies",
        selectedIds: new Set(),
        selectedPeriods: new Set(),
        limit: 10,
        waitingCustomLimit: false,
      });
      await ctx.answerCallbackQuery();
      const selectableIds = getAccessibleStrategyIds(userId);
      try {
        await ctx.editMessageText(
          `🔬 *Análisis Comparativo — Paso 1/3*\n\n` +
          `_Compara el Top N de múltiples estrategias sobre el mismo período y ve quién coincide._\n\n` +
          `Selecciona las estrategias a comparar *(mínimo 2)*:`,
          { parse_mode: "Markdown", reply_markup: buildBBTCompareStrategyKeyboard(new Set(), selectableIds) }
        );
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    if (data === "bbt_cmp_cancel") {
      bbtCmpSessionMap.delete(userId);
      waitingBBTCmpLimit.delete(userId);
      await ctx.answerCallbackQuery({ text: "Cancelado" });
      const current = await loadTestingCutoffDate(userId);
      try {
        await ctx.editMessageText(buildTestingMessage(current), {
          parse_mode: "Markdown",
          reply_markup: buildTestingKeyboard(current),
        });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    // Toggle estrategia (Compare)
    if (data.startsWith("bbt_cmp_st_") && data !== "bbt_cmp_st_done" && data !== "bbt_cmp_st_hint") {
      const session = bbtCmpSessionMap.get(userId);
      if (!session || session.step !== "strategies") { await ctx.answerCallbackQuery(); return; }
      const stratId = data.slice("bbt_cmp_st_".length);
      const selectableIds = getAccessibleStrategyIds(userId);
      if (selectableIds.includes(stratId)) {
        if (session.selectedIds.has(stratId)) session.selectedIds.delete(stratId);
        else session.selectedIds.add(stratId);
      }
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: buildBBTCompareStrategyKeyboard(session.selectedIds, selectableIds),
        });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    if (data === "bbt_cmp_st_hint") {
      await ctx.answerCallbackQuery({ text: "Selecciona al menos 2 estrategias para comparar" });
      return;
    }

    // Confirmar estrategias → pasar a período
    if (data === "bbt_cmp_st_done") {
      const session = bbtCmpSessionMap.get(userId);
      if (!session || session.selectedIds.size < 2) {
        await ctx.answerCallbackQuery({ text: "⚠️ Selecciona al menos 2 estrategias" });
        return;
      }
      session.step = "period";
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText(
          `🔬 *Análisis Comparativo — Paso 2/3*\n\n` +
          `Estrategias: *${session.selectedIds.size}* seleccionadas\n\n` +
          `Selecciona los *períodos* a analizar _(puedes elegir varios)_:`,
          { parse_mode: "Markdown", reply_markup: buildBBTComparePeriodKeyboard(session.selectedPeriods) }
        );
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    // Toggle período (Compare)
    if (data.startsWith("bbt_cmp_ctx_") && data !== "bbt_cmp_ctx_done") {
      const session = bbtCmpSessionMap.get(userId);
      if (!session || session.step !== "period") { await ctx.answerCallbackQuery(); return; }
      const periodId = data.slice("bbt_cmp_ctx_".length) as BBTCmpPeriodId;
      if (session.selectedPeriods.has(periodId)) session.selectedPeriods.delete(periodId);
      else session.selectedPeriods.add(periodId);
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageReplyMarkup({
          reply_markup: buildBBTComparePeriodKeyboard(session.selectedPeriods),
        });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    // Confirmar períodos → seleccionar límite
    if (data === "bbt_cmp_ctx_done") {
      const session = bbtCmpSessionMap.get(userId);
      if (!session || session.selectedPeriods.size === 0) {
        await ctx.answerCallbackQuery({ text: "⚠️ Selecciona al menos un período" });
        return;
      }
      session.step = "limit";
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText(
          `🔬 *Análisis Comparativo — Paso 3/3*\n\n` +
          `¿Cuántos candidatos (Top N) quieres comparar por estrategia?`,
          { parse_mode: "Markdown", reply_markup: buildBBTCompareLimitKeyboard() }
        );
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    // Límite preset (5, 10, 20, 30)
    if (data.startsWith("bbt_cmp_lim_") && data !== "bbt_cmp_lim_custom") {
      const session = bbtCmpSessionMap.get(userId);
      if (!session || session.step !== "limit") { await ctx.answerCallbackQuery(); return; }
      const n = parseInt(data.slice("bbt_cmp_lim_".length), 10);
      if (isNaN(n) || n <= 0) { await ctx.answerCallbackQuery(); return; }
      session.limit = n;
      await ctx.answerCallbackQuery({ text: `Top ${n} seleccionado` });
      await runAndShowCmpResult(ctx, userId, session);
      return;
    }

    // Límite personalizado (esperar texto)
    if (data === "bbt_cmp_lim_custom") {
      const session = bbtCmpSessionMap.get(userId);
      if (!session || session.step !== "limit") { await ctx.answerCallbackQuery(); return; }
      session.waitingCustomLimit = true;
      waitingBBTCmpLimit.add(userId);
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText(
          `🔬 *Análisis Comparativo — Top N Personalizado*\n\n` +
          `Escribe la cantidad de candidatos (1–100):`,
          { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("❌ Cancelar", "bbt_cmp_cancel") }
        );
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    // ── BallBackTest JSON Export ─────────────────────────────────────────────
    if (data === "bbt_export_json" && ctx.from && isOwner(ctx.from.id)) {
      const userId = ctx.from.id;
      const buffer = bbtResultCache.get(userId);
      if (!buffer) {
        await ctx.answerCallbackQuery({ text: "⚠️ Caché expirado.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Generando reporte forense..." });
      await ctx.replyWithDocument(new InputFile(buffer, `ballbacktest_audit_report.json`), {
        caption: "🚀 *Reporte de Auditoría Forense (JSON)*\nBallBackTest Dynamics Fusion",
        parse_mode: "Markdown",
      });
      return;
    }
  }

  // ── Exportar JSON crudo a on-demand ───────────────────────────────────────
  if (data === "prog_export_json" && ctx.from && isOwner(ctx.from.id)) {
    const userId = ctx.from.id;
    const buffer = progressiveResultCache.get(userId);
    if (!buffer) {
      await ctx.answerCallbackQuery({ text: "⚠️ Caché de análisis expirado o no encontrado.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Generando archivo JSON..." });
    await ctx.replyWithDocument(new InputFile(buffer, `progressive_analysis_export.json`), {
      caption: "📊 *Exportación datos crudos (JSON)* para Integración CRM/Dashboard",
      parse_mode: "Markdown",
    });
    return;
  }

  // ── Parlé: combinaciones de 2 sin repetición ──────────────────────────────
  if (data === PARLE_CNS_CALLBACK && ctx.from) {
    const userId = ctx.from.id;
    const cached = parleConsensusCache.get(userId);
    if (!cached) {
      await ctx.answerCallbackQuery({ text: "⚠️ Sin resultado de consenso reciente." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Generando parlés…" });
    const parleMsg = buildParleMessage(cached.nums, "Consenso Multi-Estrategia", cached.context);
    await ctx.reply(parleMsg, {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("🏠 Inicio", "volver"),
    });
    return;
  }

  // ── Adivinanza desde Consenso (solo dueño) ───────────────────────────────
  if (data === ADIVINANZA_CNS_CALLBACK && ctx.from && isOwner(ctx.from.id)) {
    const userId = ctx.from.id;
    const cached = adivinanzaConsensusCache.get(userId);
    if (!cached || cached.length === 0) {
      await ctx.answerCallbackQuery({ text: "⚠️ Sin resultado de consenso reciente." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Generando adivinanza…" });
    const loadingMsg = await ctx.reply("⏳ _Generando adivinanza..._", { parse_mode: "Markdown" });
    const chatId = loadingMsg.chat.id;
    try {
      adivinanzaLastNums.set(userId, cached);
      const texto = await generarAdivinanza(cached);
      const msg = buildAdivinanzaResultMsg(texto, cached);
      await ctx.api.editMessageText(chatId, loadingMsg.message_id, msg, {
        parse_mode: "Markdown",
        reply_markup: buildAdivinanzaResultKeyboard(),
      });
    } catch (err) {
      console.error("[adivinanza-cns] Error:", err);
      const detail = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        chatId,
        loadingMsg.message_id,
        `❌ *Error al generar la adivinanza*\n\n\`${detail}\``,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🏠 Inicio", "volver") }
      );
    }
    return;
  }

  // ── Adivinanza desde estrategia individual (solo dueño) ───────────────────
  if (data.startsWith(ADIVINANZA_STRAT_PREFIX) && ctx.from && isOwner(ctx.from.id)) {
    const userId = ctx.from.id;
    const parsed = parseAdivinanzaStratCallback(data);
    if (!parsed) {
      await ctx.answerCallbackQuery({ text: "Callback inválido." });
      return;
    }
    const strat = getStrategy(parsed.menuId);
    if (!strat?.getCandidates) {
      await ctx.answerCallbackQuery({ text: "Esta estrategia no soporta candidatos." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Generando adivinanza…" });
    const loadingMsg = await ctx.reply("⏳ _Generando adivinanza..._", { parse_mode: "Markdown" });
    const chatId = loadingMsg.chat.id;
    try {
      const isP3 = parsed.context.mapSource === "p3";
      const filteredMap = isP3
        ? await getStrategyP3Map(userId)
        : await getStrategyP4Map(userId);
      const candidates = await strat.getCandidates(parsed.context, filteredMap);
      if (candidates.length === 0) {
        await ctx.api.editMessageText(
          chatId,
          loadingMsg.message_id,
          "⚠️ La estrategia no devolvió candidatos para generar la adivinanza.",
          { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🏠 Inicio", "volver") }
        );
        return;
      }
      adivinanzaLastNums.set(userId, candidates);
      const texto = await generarAdivinanza(candidates);
      const msg = buildAdivinanzaResultMsg(texto, candidates);
      await ctx.api.editMessageText(chatId, loadingMsg.message_id, msg, {
        parse_mode: "Markdown",
        reply_markup: buildAdivinanzaResultKeyboard(),
      });
    } catch (err) {
      console.error("[adivinanza-strat] Error:", err);
      const detail = err instanceof Error ? err.message : String(err);
      await ctx.api.editMessageText(
        chatId,
        loadingMsg.message_id,
        `❌ *Error al generar la adivinanza*\n\n\`${detail}\``,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("🏠 Inicio", "volver") }
      );
    }
    return;
  }
  // ── fin Adivinanza desde estrategia ──────────────────────────────────────

  if (data.startsWith("parle_") && ctx.from) {
    const userId = ctx.from.id;
    const parsed = parseParleCallback(data);
    if (parsed) {
      const strat = getStrategy(parsed.menuId);
      if (!strat?.getCandidates) {
        await ctx.answerCallbackQuery({ text: "Esta estrategia no soporta parlé." });
        return;
      }
      await ctx.answerCallbackQuery({ text: "Generando parlés…" });
      try {
        const isP3 = parsed.context.mapSource === "p3";
        const filteredMap = isP3
          ? await getStrategyP3Map(userId)
          : await getStrategyP4Map(userId);
        const candidates = await strat.getCandidates(parsed.context, filteredMap);
        if (candidates.length < 2) {
          await ctx.reply(
            "⚠️ No hay suficientes candidatos para generar combinaciones parlé.",
            { reply_markup: new InlineKeyboard().text("◀️ Volver", "volver") }
          );
          return;
        }
        const stratLabel = STRATEGY_LABEL_BY_ID.get(parsed.menuId) ?? parsed.menuId;
        const parleMsg = buildParleMessage(candidates, stratLabel, parsed.context);
        await ctx.reply(parleMsg, {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("◀️ Volver", "volver"),
        });
      } catch (err) {
        console.error("[parle] Error:", err);
        await ctx.reply("❌ Error al generar las combinaciones parlé.", {
          reply_markup: new InlineKeyboard().text("◀️ Volver", "volver"),
        });
      }
      return;
    }
  }

  // ── Consenso: callbacks de selección ──────────────────────────────────────
  if (data.startsWith("cns_t_") && ctx.from) {
    const userId = ctx.from.id;
    const session = consensusSessionMap.get(userId);
    const stratId = data.slice("cns_t_".length);
    if (session && session.step === "selecting" && getAccessibleStrategyIds(userId).includes(stratId)) {
      if (session.selectedIds.has(stratId)) {
        session.selectedIds.delete(stratId);
      } else {
        session.selectedIds.add(stratId);
      }
      await ctx.answerCallbackQuery();
      const selectableIds = getAccessibleStrategyIds(userId);
      const ownerView = isOwner(userId);
      const msg = buildConsensusSelectionMessage(session.selectedIds, session.context, selectableIds, ownerView);
      const kb = buildConsensusSelectionKeyboard(session.selectedIds, session.context, selectableIds, ownerView, session.isPreview);
      try {
        await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }
  }

  // ── Consenso: cargar grupo predefinido ────────────────────────────────────
  if (data.startsWith("cns_g_") && ctx.from) {
    const userId = ctx.from.id;
    const session = consensusSessionMap.get(userId);
    if (session && session.step === "selecting") {
      const groupId = data.slice("cns_g_".length);
      const group = CONSENSUS_GROUPS.find((g) => g.id === groupId);
      if (group) {
        const selectableIds = getAccessibleStrategyIds(userId);
        // Reemplaza la selección actual con las estrategias del grupo (solo las seleccionables)
        const groupSelectable = group.ids.filter((id) => selectableIds.includes(id));
        session.selectedIds = new Set(groupSelectable);
        await ctx.answerCallbackQuery({ text: `Grupo ${groupId.toUpperCase()} cargado (${groupSelectable.length} estrategias)` });
        const ownerView = isOwner(userId);
        const msg = buildConsensusSelectionMessage(session.selectedIds, session.context, selectableIds, ownerView);
        const kb = buildConsensusSelectionKeyboard(session.selectedIds, session.context, selectableIds, ownerView, session.isPreview);
        try {
          await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
        } catch (e) {
          if (!(e as Error).message?.includes("message is not modified")) console.error(e);
        }
      } else {
        await ctx.answerCallbackQuery({ text: "Grupo no encontrado" });
      }
      return;
    }
  }

  // ── Consenso: seleccionar todo ────────────────────────────────────────────
  if (data === "cns_all" && ctx.from) {
    const userId = ctx.from.id;
    const session = consensusSessionMap.get(userId);
    if (session && session.step === "selecting") {
      const selectableIds = getAccessibleStrategyIds(userId);
      session.selectedIds = new Set(selectableIds);
      await ctx.answerCallbackQuery({ text: `${selectableIds.length} estrategias seleccionadas` });
      const ownerView = isOwner(userId);
      const msg = buildConsensusSelectionMessage(session.selectedIds, session.context, selectableIds, ownerView);
      const kb = buildConsensusSelectionKeyboard(session.selectedIds, session.context, selectableIds, ownerView, session.isPreview);
      try {
        await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }
  }

  // ── Consenso: limpiar selección ───────────────────────────────────────────
  if (data === "cns_none" && ctx.from) {
    const userId = ctx.from.id;
    const session = consensusSessionMap.get(userId);
    if (session && session.step === "selecting") {
      session.selectedIds = new Set();
      await ctx.answerCallbackQuery({ text: "Selección limpiada" });
      const selectableIds = getAccessibleStrategyIds(userId);
      const ownerView = isOwner(userId);
      const msg = buildConsensusSelectionMessage(session.selectedIds, session.context, selectableIds, ownerView);
      const kb = buildConsensusSelectionKeyboard(session.selectedIds, session.context, selectableIds, ownerView, session.isPreview);
      try {
        await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }
  }

  if (data === "cns_ok" && ctx.from) {
    const userId = ctx.from.id;
    const session = consensusSessionMap.get(userId);
    if (session?.step === "selecting") {
      if (session.selectedIds.size === 0) {
        await ctx.answerCallbackQuery({ text: "Selecciona al menos 1 estrategia" });
        return;
      }
      session.step = "waiting_count";
      await ctx.answerCallbackQuery();
      const count = session.selectedIds.size;
      try {
        await ctx.editMessageText(
          `✅ *${count} estrategia${count > 1 ? "s" : ""} seleccionada${count > 1 ? "s" : ""}*\n\n` +
          `¿Cuántos resultados quieres ver?\nEnvía un número del *1 al 50*.\n\n_Usa /cancel para cancelar._`,
          {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard().text(session.isPreview ? "🔙 Volver a Detalles" : "❌ Cancelar", session.isPreview ? "estrategias_request_consensus_multi" : "cns_x"),
          }
        );
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }
  }

  if (data === "cns_x" && ctx.from) {
    consensusSessionMap.delete(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "Cancelado" });
    try {
      await ctx.editMessageText("❌ Consenso cancelado.", {
        parse_mode: "Markdown",
        reply_markup: buildMainKb(ctx.from.id),
      });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  // ── Estrategia bloqueada (sin plan): mostrar descripción + pedir plan
  if (data.startsWith("locked_strat_")) {
    const menuId = data.slice("locked_strat_".length);
    await ctx.answerCallbackQuery();
    const label = getExtraMenuLabel(menuId) || menuId;
    const desc = getExtraMenuDescription(menuId);
    let msg = `🔒 *${escapeMd(label)}*\n\n`;
    if (desc) {
      msg += `_${escapeMd(desc)}_\n\n`;
    }
    msg += "⚠️ Para ver los resultados de esta estrategia debes adquirir un plan.\n\n" +
           "📋 _Elige un plan para desbloquear todas las estrategias y funciones avanzadas._";
    const kb = new InlineKeyboard()
      .text("📋 Ver Planes", "ver_planes_open").row()
      .text("◀️ Volver a Estrategias", ESTRATEGIAS_OPEN_CALLBACK).row()
      .text("🏠 Volver al Inicio", "volver");
    try {
      await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  if (data.startsWith(EXTRA_MENU_CALLBACK_PREFIX)) {
    const menuId = data.slice(EXTRA_MENU_CALLBACK_PREFIX.length);

    // ── Gating: si el usuario no tiene plan, mostrar descripción + pedir plan ──
    const callerUserId = ctx.from?.id;
    if (callerUserId && !isOwner(callerUserId) && !hasPlan(callerUserId)) {
      await ctx.answerCallbackQuery();
      const label = getExtraMenuLabel(menuId) || menuId;
      const desc = getExtraMenuDescription(menuId);
      let msg = `🔒 *${escapeMd(label)}*\n\n`;
      if (desc) {
        msg += `_${escapeMd(desc)}_\n\n`;
      }
      msg += "⚠️ Para ver los resultados de esta estrategia debes adquirir un plan.\n\n" +
             "📋 _Elige un plan para desbloquear todas las estrategias y funciones avanzadas._";
      const kb = new InlineKeyboard()
        .text("📋 Ver Planes", "ver_planes_open").row()
        .text("◀️ Volver a Estrategias", ESTRATEGIAS_OPEN_CALLBACK).row()
        .text("🏠 Volver al Inicio", "volver");
      try {
        await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }

    if (getExtraMenuStatus(menuId) === "pendiente") {
      await ctx.answerCallbackQuery();
      const desc = getExtraMenuDescription(menuId);
      const text = desc
        ? `${MENU_PENDIENTE_MESSAGE}\n\n_${desc}_`
        : MENU_PENDIENTE_MESSAGE;
      try {
        await ctx.editMessageText(text, {
          parse_mode: "Markdown",
          reply_markup: buildMainKb(ctx.from?.id),
        });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }
    const handler = getHandler(menuId);
    if (handler) {
      await handler(ctx);
      return;
    }
    // Fallback: estrategia con runner pero sin handler registrado (ej. arranque sin Sheet)
    if (hasStrategyRunner(menuId)) {
      await showStrategyContextSelection(ctx, menuId);
      return;
    }
  }

  if (data === "fijo_fecha" || data === "corrido_fecha" || data === "ambos_fecha") {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    const game: GameMenu = data === "fijo_fecha" ? "fijo" : data === "corrido_fecha" ? "corrido" : "ambos";
    if (userId) {
      waitingCustomDateGame.set(userId, game);
      const label = game === "fijo" ? "Fijo (P3)" : game === "corrido" ? "Corrido (P4)" : "Fijo y Corrido";
      result = `📅 *Escoger fecha — ${label}*\n\nEscribe la fecha en *MM/DD/AA* (ej: 02/25/26).\n\nUsa /cancel para cancelar.`;
    } else {
      result = "No se pudo iniciar.";
    }
    keyboard = buildMainKb(ctx.from?.id);
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  // ── Charada Cubana ────────────────────────────────────────────────────────
  if (data === "charada_open") {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(
        "🃏 *Charada Cubana*\n\nSistema de numerología popular cubano: 100 números (00–99) con sus significados tradicionales.\n\nElige una opción:",
        { parse_mode: "Markdown", reply_markup: buildCharadaMenuKeyboard() }
      );
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  if (data.startsWith("charada_cat_")) {
    const page = parseInt(data.slice("charada_cat_".length), 10);
    if (!Number.isNaN(page) && page >= 0 && page < 5) {
      await ctx.answerCallbackQuery();
      try {
        await ctx.editMessageText(buildCatalogPage(page), {
          parse_mode: "Markdown",
          reply_markup: buildCharadaCatalogKeyboard(page),
        });
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
      return;
    }
  }

  if (data === "charada_buscar" && ctx.from) {
    waitingCharadaSearch.set(ctx.from.id, true);
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText(
        "🔍 *Buscar en la Charada Cubana*\n\n" +
        "✍️ *¿Qué quieres buscar?*\n\n" +
        "• Escribe un *número* del `00` al `99` para ver su significado.\n" +
        "• Escribe una *palabra* (ej: `gato`, `agua`, `muerte`) para encontrar todas las entradas que la contengan.\n\n" +
        "👇 *Escribe tu búsqueda aquí abajo y pulsa Enviar*\n\n" +
        "_Usa /cancel para cancelar._",
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("❌ Cancelar búsqueda", "charada_cancel_search"),
        }
      );
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  if (data === "charada_cancel_search" && ctx.from) {
    waitingCharadaSearch.delete(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "Búsqueda cancelada" });
    try {
      await ctx.editMessageText(
        "🃏 *Charada Cubana*\n\nSistema de numerología popular cubano.\n\nElige una opción:",
        { parse_mode: "Markdown", reply_markup: buildCharadaMenuKeyboard() }
      );
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  if (data === "charada_noop" || data === "noop_plan" || data === "noop_cambiar" || data === "noop" || data === "noop_list_page") {
    await ctx.answerCallbackQuery();
    return;
  }
  // ── fin Charada ────────────────────────────────────────────────────────────

  result = "Opción no reconocida. Usa /start para ver el menú.";
  try {
    if (!asyncData) await ctx.answerCallbackQuery().catch(() => { });
    await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch (err) {
    if (!asyncData) await ctx.answerCallbackQuery({ text: "Listo ✓" }).catch(() => { });
    const msg = (err as Error).message ?? "";
    if (!msg.includes("message is not modified")) console.error("Error en callback_query:", err);
  }
});

bot.command("cancel", async (ctx) => {
  const userId = ctx.from?.id;
  if (userId) {
    waitingCustomDateGame.delete(userId);
    consensusSessionMap.delete(userId);
    waitingCharadaSearch.delete(userId);
    waitingTestingDate.delete(userId);
    waitingAdivinanzaNums.delete(userId);
    waitingSugerenciaText.delete(userId);
    waitingAnnouncementInput.delete(userId);
    progressiveSessionMap.delete(userId);
    waitingProgressiveDate.delete(userId);
    const wasInPlanFlow = creatingPlanFlow.has(userId) || editingPlanFlow.has(userId);
    clearAllFlows(userId);
    if (wasInPlanFlow && isOwner(userId)) {
      await ctx.reply("Cancelado. Gestionar planes:", {
        reply_markup: buildManagePlansKeyboard(),
      });
      return;
    }
  }
  await ctx.reply("Cancelado.", { reply_markup: buildMainKb(ctx.from?.id) });
});

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id;
  const text = ctx.message.text?.trim() ?? "";

  const securityHandled = await handleSecurityMessage(ctx, {
    isOwner,
    buildMainKeyboard: buildMainKb,
    onMenuCreated: (id, label, description, createdBy) => {
      registerExtraMenu(id, label, (c) => placeholderMenuHandler(c), {
        description,
        isPlaceholder: true,
      });
      if (createdBy != null) void toggleExtraMenu(createdBy, id);
    },
    getP3Map: () => getP3Map(),
    getP4Map: () => getP4Map(),
    getHotThresholdDays: () => hotThresholdDays,
    getExtraMenuLabel: (id) => getExtraMenuLabel(id),
  });
  if (securityHandled) return;

  // ── UNODOSTRES+: Entrada interactiva cantidad de candidatos ───────────────
  if (userId && waitingPlusLimit.has(userId)) {
    const session = waitingPlusLimit.get(userId)!;
    if (text === "/cancel" || text.toLowerCase() === "cancelar") {
      waitingPlusLimit.delete(userId);
      await ctx.reply("Operación cancelada.", { reply_markup: buildMainKb(userId) });
      return;
    }

    const limit = parseInt(text, 10);
    if (isNaN(limit) || limit <= 0 || limit > 100) {
      await ctx.reply("❌ Por favor escribe un número válido entre 1 y 100.");
      return;
    }

    waitingPlusLimit.delete(userId);
    session.context.params = { ...session.context.params, limit };

    // Ejecutar asíncronamente con un wrapper ctx falso que responde en el mismo chat
    const fakeCtx = {
      from: { id: userId },
      answerCallbackQuery: async () => { }, // Noop para un msg
      editMessageText: async (msgText: string, opts?: object) => {
        await ctx.reply(msgText, opts as any);
      },
      reply: async (msgText: string, opts?: object) => {
        await ctx.reply(msgText, opts as any);
      }
    };

    await runStrategyAndShowResult(fakeCtx, session.menuId, session.context);
    return;
  }

  // ── Progresivo: entrada de fechas inicial/final (solo dueño) ─────────────
  if (userId && isOwner(userId) && waitingProgressiveDate.has(userId)) {
    const which = waitingProgressiveDate.get(userId)!;
    const session = progressiveSessionMap.get(userId);

    if (!session) {
      waitingProgressiveDate.delete(userId);
      return;
    }

    const key = parseUserDateToMMDDYY(text);
    if (!key) {
      await ctx.reply(
        "❌ Fecha no válida. Usa el formato `MM/DD/YY` (ej: `01/01/25`).",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (which === "start") {
      session.startDate = key;
      session.step = "end_date";
      waitingProgressiveDate.set(userId, "end");

      const mapSource = session.context!.mapSource;
      const period = session.context!.period;
      const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";
      const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";

      await ctx.reply(
        `📈 *Análisis Progresivo* — ${mapLabel} · ${periodLabel}\n\n` +
        `✅ Fecha inicial: \`${key}\`\n\n` +
        `📅 Ahora ingresa la *fecha final* del análisis.\n` +
        `Formato: \`MM/DD/YY\` _(ej: \`12/31/25\`)_\n\n` +
        `_/cancel para cancelar._`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("❌ Cancelar", "prog_cancel"),
        }
      );
      return;
    }

    if (which === "end") {
      // Valida que endDate > startDate
      const startDt = mmddyyToDate(session.startDate!);
      const endDt = mmddyyToDate(key);

      if (!startDt || !endDt || endDt <= startDt) {
        await ctx.reply(
          `❌ La fecha final debe ser posterior a la inicial (\`${session.startDate}\`).`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      session.endDate = key;
      session.step = "strategies";
      waitingProgressiveDate.delete(userId);

      const selectableIds = getAccessibleStrategyIds(userId);
      const msg = buildProgressiveStrategyMessage(
        session.selectedIds,
        session.context!,
        selectableIds,
        session.startDate!,
        session.endDate!
      );
      const kb = buildProgressiveStrategyKeyboard(session.selectedIds, selectableIds);
      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
      return;
    }
  }

  // ── BallBackTest: entrada de fechas inicial/final (solo dueño) ─────────────
  if (userId && isOwner(userId) && waitingBBTDate.has(userId)) {
    const which = waitingBBTDate.get(userId)!;
    const session = bbtSessionMap.get(userId);

    if (!session) {
      waitingBBTDate.delete(userId);
      return;
    }

    const key = parseUserDateToMMDDYY(text);
    if (!key) {
      await ctx.reply(
        "❌ Fecha no válida. Usa el formato `MM/DD/YY` (ej: `01/01/25`).",
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (which === "start") {
      session.startDate = key;
      session.step = "end_date";
      waitingBBTDate.set(userId, "end");

      const ctxHeader = [...session.selectedContexts].map(c => c.toUpperCase().replace("_", "")).join("+");

      await ctx.reply(
        `🚀 *BallBackTest* — ${ctxHeader}\n\n` +
        `✅ Fecha inicial: \`${key}\`\n\n` +
        `📅 Ahora ingresa la *fecha final* del análisis.\n` +
        `Formato: \`MM/DD/YY\` _(ej: \`12/31/25\`)_\n\n` +
        `_/cancel para cancelar._`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("❌ Cancelar", "bbt_cancel"),
        }
      );
      return;
    }

    if (which === "end") {
      const startDt = mmddyyToDate(session.startDate!);
      const endDt = mmddyyToDate(key);

      if (!startDt || !endDt || endDt <= startDt) {
        await ctx.reply(
          `❌ La fecha final debe ser posterior a la inicial (\`${session.startDate}\`).`,
          { parse_mode: "Markdown" }
        );
        return;
      }

      session.endDate = key;
      session.step = "strategies";
      waitingBBTDate.delete(userId);

      const contextsArray = bbtContextsFromSet(session.selectedContexts);

      const selectableIds = getAccessibleStrategyIds(userId);
      const msg = buildBBTStrategyMessage(
        session.selectedIds,
        contextsArray,
        selectableIds,
        session.startDate!,
        session.endDate!
      );
      const kb = buildBBTStrategyKeyboard(session.selectedIds, selectableIds);
      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: kb });
      return;
    }
  }

  // ── BallBackTest: entrada de Top N (solo dueño) ───────────────────────────
  if (userId && isOwner(userId) && waitingBBTTopN.has(userId)) {
    const session = bbtSessionMap.get(userId);
    if (!session || session.step !== "top_n") {
      waitingBBTTopN.delete(userId);
      return;
    }

    const n = parseInt(text, 10);
    if (isNaN(n) || n < 0) {
      await ctx.reply("❌ Ingresa un número válido (0 o mayor).");
      return;
    }

    session.topN = n;
    session.step = "confirm";
    waitingBBTTopN.delete(userId);

    // Estimar fechas (Logic fusionada para P3+P4)
    const hasP3 = [...session.selectedContexts].some(c => c.startsWith("p3"));
    const hasP4 = [...session.selectedContexts].some(c => c.startsWith("p4"));

    let fullMap: DateDrawsMap = {};
    if (hasP3 && hasP4) {
      const [p3, p4] = await Promise.all([getP3Map(), getP4Map()]);
      const allDates = new Set([...Object.keys(p3), ...Object.keys(p4)]);
      for (const d of allDates) fullMap[d] = { ...(p3[d] || {}), ...(p4[d] || {}) };
    } else if (hasP3) {
      fullMap = await getP3Map();
    } else {
      fullMap = (await getP4Map()) as DateDrawsMap;
    }

    const firstCtx = bbtContextsFromSet(session.selectedContexts)[0]
      ?? { mapSource: "p3" as const, period: "m" as const };

    const estimated = countDatesInRange(fullMap, session.startDate!, session.endDate!, firstCtx);
    session.estimatedDates = estimated;

    const ctxHeader = [...session.selectedContexts]
      .map(c => c === "p3_a" ? "P3A" : c.toUpperCase().replace("_", "")).join("+");
    const numCombos = (1 << Math.min(session.selectedIds.size, BBT_MAX_STRATEGIES)) - 1;

    await ctx.reply(
      `🚀 *BallBackTest — Confirmación*\n\n` +
      `📅 *Rango:* \`${session.startDate}\` → \`${session.endDate}\`\n` +
      `📦 *Contextos:* \`${ctxHeader}\`\n` +
      `🎯 *Top N:* ${n === 0 ? "TODOS" : n}\n` +
      `🔢 *Sorteos:* ${estimated}\n` +
      `📊 *Estrategias:* ${session.selectedIds.size} (${numCombos} combos)\n\n` +
      `¿Confirmas el inicio de la auditoría forense?`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ Confirmar", "bbt_confirm")
          .text("❌ Cancelar", "bbt_cancel"),
      }
    );
    return;
  }

  // ── BBT Compare: entrada de límite personalizado (solo dueño) ───────────────
  if (userId && isOwner(userId) && waitingBBTCmpLimit.has(userId)) {
    const session = bbtCmpSessionMap.get(userId);
    if (!session || !session.waitingCustomLimit) {
      waitingBBTCmpLimit.delete(userId);
      return;
    }
    const n = parseInt(text, 10);
    if (isNaN(n) || n <= 0 || n > 100) {
      await ctx.reply("❌ Ingresa un número válido entre 1 y 100.");
      return;
    }
    session.limit = n;
    session.waitingCustomLimit = false;
    await runAndShowCmpResult(ctx, userId, session);
    return;
  }

  // ── Testing: entrada de fecha de corte (solo dueño) ───────────────────────
  if (userId && isOwner(userId) && waitingTestingDate.has(userId)) {
    waitingTestingDate.delete(userId);
    if (!/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(text)) {
      await ctx.reply(
        "❌ Formato inválido. Usa *MM/DD/YY* (ej: `12/31/25`). Vuelve a intentarlo desde el menú.",
        { parse_mode: "Markdown", reply_markup: buildMainKb(userId) }
      );
      return;
    }
    try {
      await saveTestingCutoffDate(text, userId);
      invalidateTestingCutoffCache(userId);
      await ctx.reply(buildTestingMessage(text), {
        parse_mode: "Markdown",
        reply_markup: buildTestingKeyboard(text),
      });
    } catch {
      await ctx.reply("❌ Error al guardar la fecha. Revisa los logs.", {
        reply_markup: buildMainKb(userId),
      });
    }
    return;
  }
  // ── fin Testing ───────────────────────────────────────────────────────────

  // ── Sugerencia: guardar texto del usuario ───────────────────────────────────
  if (userId && waitingSugerenciaText.has(userId)) {
    waitingSugerenciaText.delete(userId);
    const maxLen = 500;
    const trimmed = text.slice(0, maxLen);
    try {
      const { nowSugerenciaDate } = await import("./sugerencia.js");
      await appendSugerenciaToDB({
        userId,
        nombre: getUsername(userId) ?? "",
        telefono: getPhone(userId) ?? "",
        texto: trimmed,
        fecha: nowSugerenciaDate(),
      });
      await ctx.reply(
        "✅ *¡Gracias por tu sugerencia!*\n\nTu mensaje ha sido enviado al administrador.",
        { parse_mode: "Markdown", reply_markup: buildMainKb(userId) }
      );
      // Push a todos los owners notificando la nueva sugerencia
      const senderName = getUsername(userId)
        ? `@${getUsername(userId)}`
        : (ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name ?? String(userId)));
      const ownerPushMsg = `💡 *Nueva sugerencia recibida*\n\nEl usuario ${senderName} (\`${userId}\`) acaba de enviar una sugerencia:\n\n_"${trimmed.slice(0, 200)}${trimmed.length > 200 ? "…" : ""}"_`;
      const ownerPushKb = new InlineKeyboard().text("📋 Ver sugerencias", "admin_sugerencia_open");
      for (const oid of getOwnerIds()) {
        bot.api.sendMessage(oid, ownerPushMsg, { parse_mode: "Markdown", reply_markup: ownerPushKb }).catch(() => { });
      }
    } catch (err) {
      console.error("[sugerencia] Error al guardar:", err);
      await ctx.reply(
        "❌ Hubo un error al enviar tu sugerencia. Por favor intenta de nuevo más tarde.",
        { reply_markup: buildMainKb(userId) }
      );
    }
    return;
  }
  // ── fin Sugerencia ─────────────────────────────────────────────────────────

  // ── Anuncios: captura del texto creado/editado por el admin ──────────────
  if (userId && isOwner(userId) && waitingAnnouncementInput.has(userId)) {
    const mode = waitingAnnouncementInput.get(userId)!;
    waitingAnnouncementInput.delete(userId);
    const trimmed = text.slice(0, 300);
    try {
      const { buildAdminAnnouncementsKeyboard, buildAdminAnnouncementsText } = await import("./announcements.js");
      if (mode === "create") {
        const { nowSugerenciaDate } = await import("./sugerencia.js");
        const updated = await addAnnouncement(trimmed, nowSugerenciaDate());
        invalidateAnnouncementsCache();
        await ctx.reply(
          "✅ *Anuncio creado.*\n\n" + buildAdminAnnouncementsText(updated),
          { parse_mode: "Markdown", reply_markup: buildAdminAnnouncementsKeyboard(updated.length > 0) }
        );
        // Enviar push a todos los usuarios (allowed + owners)
        const pushMsg = `📢 *Nuevo Anuncio*\n\n📌 ${trimmed}`;
        const allRecipients = new Set([
          ...getAllowedUsers(),
          ...getOwnerIds(),
        ]);
        for (const recipientId of allRecipients) {
          bot.api.sendMessage(recipientId, pushMsg, { parse_mode: "Markdown" }).catch(() => { });
        }
      } else if (mode.startsWith("edit:")) {
        const annId = mode.replace("edit:", "");
        const updated = await editAnnouncement(annId, trimmed);
        invalidateAnnouncementsCache();
        const items = updated ?? await loadAnnouncementsFromDB(true);
        await ctx.reply(
          (updated ? "✅ *Anuncio editado.*\n\n" : "❌ No se encontró el anuncio.\n\n") + buildAdminAnnouncementsText(items),
          { parse_mode: "Markdown", reply_markup: buildAdminAnnouncementsKeyboard(items.length > 0) }
        );
      }
    } catch (err) {
      console.error("[announcements] Error al guardar:", err);
      await ctx.reply("❌ Error al guardar el anuncio. Revisa los logs.", {
        reply_markup: buildMainKb(userId),
      });
    }
    return;
  }
  // ── fin Anuncios ──────────────────────────────────────────────────────────

  // ── Adivinanza: entrada de lista de números (solo dueño) ──────────────────
  if (userId && isOwner(userId) && waitingAdivinanzaNums.has(userId)) {
    waitingAdivinanzaNums.delete(userId);
    const numbers = parseNumberList(text);
    if (!numbers) {
      await ctx.reply(
        "❌ Lista inválida. Ingresa entre 1 y 20 números separados por espacios o comas (ej: `7 23 45 12`).",
        { parse_mode: "Markdown", reply_markup: buildAdivinanzaMenuKeyboard() }
      );
      return;
    }
    const loadingMsg = await ctx.reply(
      "⏳ _Generando adivinanza..._",
      { parse_mode: "Markdown" }
    );
    try {
      adivinanzaLastNums.set(userId, numbers);
      const texto = await generarAdivinanza(numbers);
      const msg = buildAdivinanzaResultMsg(texto, numbers);
      await ctx.api.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        msg,
        { parse_mode: "Markdown", reply_markup: buildAdivinanzaResultKeyboard() }
      );
    } catch (err) {
      console.error("[adivinanza] Error al generar:", err);
      const detail = err instanceof Error ? err.message : String(err);
      try {
        await ctx.api.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          `❌ *Error al generar la adivinanza*\n\n\`${detail}\``,
          { parse_mode: "Markdown", reply_markup: buildAdivinanzaMenuKeyboard() }
        );
      } catch {
        await ctx.reply(`❌ Error al generar la adivinanza:\n\`${detail}\``, {
          parse_mode: "Markdown",
          reply_markup: buildMainKb(userId),
        });
      }
    }
    return;
  }
  // ── fin Adivinanza ────────────────────────────────────────────────────────

  // ── Consenso: entrada de cantidad de resultados ──────────────────────────
  const consensusSession = userId ? consensusSessionMap.get(userId) : undefined;
  if (userId && consensusSession?.step === "waiting_count") {
    consensusSessionMap.delete(userId);
    const count = parseInt(text, 10);
    if (Number.isNaN(count) || count < 1 || count > 50) {
      await ctx.reply("❌ Número no válido (debe ser entre 1 y 50). Usa /start para volver.", {
        reply_markup: buildMainKb(userId),
      });
      return;
    }
    try {
      const isP3 = consensusSession.context.mapSource === "p3";
      const map = isP3 ? await getStrategyP3Map(userId) : await getStrategyP4Map(userId);
      const { message: msg, rankedNums } = await runConsensusAggregation(
        consensusSession.context,
        [...consensusSession.selectedIds],
        count,
        map,
        getStrategy
      );
      // Guarda los números del consenso para "Hacer parlé" y "Crear Adivinanza"
      if (rankedNums.length >= 2) {
        parleConsensusCache.set(userId, { nums: rankedNums, context: consensusSession.context });
      }
      if (rankedNums.length >= 1 && isOwner(userId)) {
        adivinanzaConsensusCache.set(userId, rankedNums);
      }
      const consensusKb = new InlineKeyboard();
      if (consensusSession.isPreview) {
        consensusKb.text("✅ Solicitar Acceso", `estrategias_confirm_request_consensus_multi`).row();
        markStrategyAsPreviewed(userId, "consensus_multi");
        consensusKb.text("🔙 Volver a Detalles", "estrategias_request_consensus_multi");
      } else {
        if (rankedNums.length >= 2) {
          consensusKb.text("🎰 Hacer parlé", PARLE_CNS_CALLBACK);
          if (isOwner(userId)) {
            consensusKb.text("🔮 Crear Adivinanza", ADIVINANZA_CNS_CALLBACK);
          }
          consensusKb.row();
        } else if (rankedNums.length >= 1 && isOwner(userId)) {
          consensusKb.text("🔮 Crear Adivinanza", ADIVINANZA_CNS_CALLBACK).row();
        }
        consensusKb.text("🏠 Inicio", "volver");
      }
      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: consensusKb });
      // Verificación testing: solo para dueños con fecha de corte activa
      if (isOwner(userId)) {
        const cutoff = await getTestingCutoff(userId);
        if (cutoff) {
          try {
            const fullMap = isP3 ? await getP3Map() : (await getP4Map()) as DateDrawsMap;
            const nextResult = getNextDrawResult(fullMap, cutoff, consensusSession.context.period, consensusSession.context.mapSource);
            if (nextResult) {
              const verifBlock = buildTestingVerificationBlock(nextResult, rankedNums, consensusSession.context);
              await ctx.reply(verifBlock, { parse_mode: "Markdown" });
            }
          } catch (verifErr) {
            console.error("[testing-verif] Error al generar verificación consenso:", verifErr);
          }
        }
      }
    } catch (err) {
      console.error("Error en consenso:", err);
      await ctx.reply("❌ Error al calcular el consenso. Vuelve a intentarlo.", {
        reply_markup: buildMainKb(userId),
      });
    }
    return;
  }

  // ── Charada: búsqueda por texto o número ───────────────────────────────────
  if (userId && waitingCharadaSearch.has(userId)) {
    waitingCharadaSearch.delete(userId);
    const results = searchCharada(text);
    const msg = buildSearchMessage(text, results);
    await ctx.reply(msg, {
      parse_mode: "Markdown",
      reply_markup: buildCharadaMenuKeyboard(),
    });
    return;
  }

  const game = userId ? waitingCustomDateGame.get(userId) : undefined;
  if (!userId || game === undefined) return;
  waitingCustomDateGame.delete(userId);
  const key = parseUserDateToMMDDYY(text);
  if (!key) {
    await ctx.reply("❌ Fecha no válida. Usa MM/DD/AA (ej: 02/25/26).", {
      reply_markup: buildMainKb(ctx.from?.id),
    });
    return;
  }
  try {
    const [map3, map4] = await Promise.all([getP3Map(), getP4Map()]);
    const d3 = map3[key] ?? {};
    const d4 = map4[key] ?? {};
    const msg = buildResultOneDay(key, d3, d4, game, "Fecha");
    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: buildMainKb(ctx.from?.id) });
  } catch (e) {
    console.error("PDF map error:", e);
    await ctx.reply("No pude cargar los PDF. Prueba más tarde.", {
      reply_markup: buildMainKb(ctx.from?.id),
    });
  }
});

function formatDrawsForMessage(dateLabel: string, draws: { m?: number[]; e?: number[] }): string {
  let s = `*${dateLabel}*\n`;
  if (draws.m?.length) s += `☀️ Mediodía (M): \`${draws.m.join("-")}\`\n`;
  if (draws.e?.length) s += `🌙 Noche (E): \`${draws.e.join("-")}\`\n`;
  if (!draws.m?.length && !draws.e?.length) s += "_Sin datos_\n";
  return s.trim();
}

function buildResultOneDay(
  key: string,
  d3: { m?: number[]; e?: number[] },
  d4: { m?: number[]; e?: number[] },
  game: GameMenu,
  title: string
): string {
  if (game === "fijo") {
    return `☀️🌙 *${title}* (Fijo) ${key}\n\n` + formatDrawsForMessage(key, d3);
  }
  if (game === "corrido") {
    return `☀️🌙 *${title}* (Corrido) ${key}\n\n` + formatDrawsForMessage(key, d4);
  }
  return (
    `☀️🌙 *${title}* ${key}\n\n*Fijo*\n` +
    formatDrawsForMessage(key, d3) +
    "\n\n*Corrido*\n" +
    formatDrawsForMessage(key, d4)
  );
}

function buildResultWeek(
  map3: Record<string, { m?: number[]; e?: number[] }>,
  map4: Record<string, { m?: number[]; e?: number[] }>,
  dates: string[],
  game: GameMenu
): string {
  let body = "📆 *Esta semana*";
  if (game === "fijo") body += " — Fijo (P3)";
  else if (game === "corrido") body += " — Corrido (P4)";
  body += "\n\n";
  for (const key of dates) {
    const d3 = map3[key];
    const d4 = map4[key];
    if (game === "fijo" && d3 && (d3.m || d3.e)) {
      body += `*${key}*\n` + formatDrawsForMessage(key, d3).replace(/^\*[^*]+\*\n/, "") + "\n\n";
    } else if (game === "corrido" && d4 && (d4.m || d4.e)) {
      body += `*${key}*\n` + formatDrawsForMessage(key, d4).replace(/^\*[^*]+\*\n/, "") + "\n\n";
    } else if (game === "ambos" && ((d3 && (d3.m || d3.e)) || (d4 && (d4.m || d4.e)))) {
      body += `*${key}*\n`;
      if (d3 && (d3.m || d3.e)) body += "Fijo: " + formatDrawsForMessage(key, d3).replace(/^\*[^*]+\*\n/, "") + "\n";
      if (d4 && (d4.m || d4.e)) body += "Corrido: " + formatDrawsForMessage(key, d4).replace(/^\*[^*]+\*\n/, "") + "\n";
      body += "\n";
    }
  }
  return body.trim() || "_Sin datos para estos días._";
}

function getTodayFloridaMMDDYY(): string {
  const s = new Date().toLocaleDateString("en-CA", { timeZone: FLORIDA_TZ });
  const [y, m, d] = s.split("-");
  return `${m}/${d}/${y!.slice(-2)}`;
}
function getYesterdayFloridaMMDDYY(): string {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 864e5);
  const s = yesterday.toLocaleDateString("en-CA", { timeZone: FLORIDA_TZ });
  const [y, m, d] = s.split("-");
  return `${m}/${d}/${y!.slice(-2)}`;
}
function getThisWeekFloridaMMDDYY(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const s = d.toLocaleDateString("en-CA", { timeZone: FLORIDA_TZ });
    const [y, m, day] = s.split("-");
    out.push(`${m}/${day}/${y!.slice(-2)}`);
  }
  return out;
}

function parseUserDateToMMDDYY(text: string): string | null {
  const t = text.trim();
  const slash2 = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/;
  const dash = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
  let mm: number, dd: number, yy: number;
  const m2 = t.match(slash2);
  if (m2) {
    const a = parseInt(m2[1], 10);
    const b = parseInt(m2[2], 10);
    yy = parseInt(m2[3], 10);
    yy = yy >= 50 ? 1900 + yy : 2000 + yy;
    if (a > 12) {
      dd = a;
      mm = b;
    } else if (b > 12) {
      mm = a;
      dd = b;
    } else {
      mm = a;
      dd = b;
    }
  } else {
    const m1 = t.match(dash);
    if (!m1) return null;
    yy = parseInt(m1[1], 10);
    mm = parseInt(m1[2], 10);
    dd = parseInt(m1[3], 10);
  }
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const lastDay = new Date(yy, mm, 0).getDate();
  if (dd > lastDay) return null;
  const yy2 = String(yy).slice(-2);
  return `${String(mm).padStart(2, "0")}/${String(dd).padStart(2, "0")}/${yy2}`;
}

const P3_PDF_URL = "https://files.floridalottery.com/exptkt/p3.pdf";
const P4_PDF_URL = "https://files.floridalottery.com/exptkt/p4.pdf";

export type Pick3Numbers = [number, number, number];
export type DateDrawsMap = Record<string, { m?: number[]; e?: number[] }>;
export type DateDrawsMapP4 = Record<string, { m?: number[]; e?: number[] }>;

const P3_RECORD_REGEX =
  /(\d{2}\/\d{2}\/\d{2})\s*([EM])\s*(\d)[\s\-]*(\d)[\s\-]*(\d)(?:\s+FB\s*(\d))?/gi;
const P4_RECORD_REGEX =
  /(\d{2}\/\d{2}\/\d{2})\s*([EM])\s*(\d)[\s\-]*(\d)[\s\-]*(\d)[\s\-]*(\d)(?:\s+FB\s*(\d))?/gi;

function parseP3FullText(text: string): DateDrawsMap {
  const map: DateDrawsMap = {};
  const normalized = text
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let m: RegExpExecArray | null;
  P3_RECORD_REGEX.lastIndex = 0;
  while ((m = P3_RECORD_REGEX.exec(normalized)) !== null) {
    const date = m[1]!;
    const type = m[2]!.toUpperCase() === "E" ? "e" : "m";
    const numbers: Pick3Numbers = [Number(m[3]), Number(m[4]), Number(m[5])];
    if (!map[date]) map[date] = {};
    map[date][type] = numbers;
  }
  return map;
}

function parseP4FullText(text: string): DateDrawsMapP4 {
  const map: DateDrawsMapP4 = {};
  const normalized = text
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let m: RegExpExecArray | null;
  P4_RECORD_REGEX.lastIndex = 0;
  while ((m = P4_RECORD_REGEX.exec(normalized)) !== null) {
    const date = m[1]!;
    const type = m[2]!.toUpperCase() === "E" ? "e" : "m";
    const numbers = [Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])] as [number, number, number, number];
    if (!map[date]) map[date] = {};
    map[date][type] = numbers;
  }
  return map;
}

async function pdfToText(pdfBuffer: ArrayBuffer): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(pdfBuffer);
  /* Sin standardFontDataUrl para evitar errores en entornos tipo Render donde file:// falla (LiberationSans). */
  const doc = await pdfjsLib.getDocument({
    data,
    disableFontFace: true,
  }).promise;
  const numPages = doc.numPages;
  const pageTexts: string[] = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    type Item = { str: string; transform?: number[] };
    const rawItems = content.items as Item[];
    const items = [...rawItems].sort((a, b) => {
      const yA = a.transform?.[5] ?? 0;
      const yB = b.transform?.[5] ?? 0;
      const xA = a.transform?.[4] ?? 0;
      const xB = b.transform?.[4] ?? 0;
      if (Math.abs(yA - yB) > 2) return yB - yA;
      return xA - xB;
    });
    let lastY: number | null = null;
    const lineParts: string[] = [];
    const lines: string[] = [];
    for (const item of items) {
      const y = item.transform?.[5] ?? 0;
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(lineParts.join(" ").trim());
        lineParts.length = 0;
      }
      lastY = y;
      lineParts.push(item.str);
    }
    if (lineParts.length > 0) lines.push(lineParts.join(" ").trim());
    pageTexts.push(lines.join("\n"));
  }
  return pageTexts.join("\n");
}

/**
 * Determina el momento esperado de la última actualización de datos en Florida.
 * Horarios de sorteos: Midday (13:30 sorteo, ~14:05 PDF), Evening (21:45 sorteo, ~20:20 PDF? wait!)
 * El usuario indica 14:05 y 20:20.
 */
function getLastExpectedUpdateTime(): number {
  const floridaNowStr = new Date().toLocaleString("en-US", { timeZone: "America/New_York" });
  const floridaNow = new Date(floridaNowStr);

  const t1405 = new Date(floridaNow);
  t1405.setHours(14, 5, 0, 0);

  const t2020 = new Date(floridaNow);
  t2020.setHours(20, 20, 0, 0);

  if (floridaNow.getTime() >= t2020.getTime()) return t2020.getTime();
  if (floridaNow.getTime() >= t1405.getTime()) return t1405.getTime();

  // Si es antes de las 14:05, el último fue a las 20:20 del día anterior
  const yesterday2020 = new Date(t2020);
  yesterday2020.setDate(yesterday2020.getDate() - 1);
  return yesterday2020.getTime();
}

let cachedP3Map: DateDrawsMap | null = null;
let cachedP4Map: DateDrawsMapP4 | null = null;
let lastP3Fetch = 0;
let lastP4Fetch = 0;
/** Tracks date|period pairs that already fired a combined push to admins (dedup guard). */
const hitNotifiedPairs = new Set<string>();

async function getP3Map(): Promise<DateDrawsMap> {
  const leut = getLastExpectedUpdateTime();
  // Refrescar si no hay caché O si el último fetch es anterior al LEUT
  if (cachedP3Map && lastP3Fetch >= leut) return cachedP3Map;

  console.log(`[data] Refrescando mapa P3 (Evento: ${lastP3Fetch < leut ? "Nuevo sorteo disponible" : "Inicio"})`);
  const res = await fetch(P3_PDF_URL, { headers: { "User-Agent": "FloridaLotteryBot/1.0" } });
  if (!res.ok) throw new Error(`P3 PDF ${res.status}`);
  const data = await res.arrayBuffer();
  const txt = await pdfToText(data);
  cachedP3Map = parseP3FullText(txt);
  lastP3Fetch = Date.now();

  if (process.env.DATABASE_URL) {
    import("./infrastructure/database/PostgresDrawRepository.js")
      .then(m => m.saveDrawsToDB("p3", cachedP3Map!))
      .catch(e => console.error("Error guardando P3 en Postgres:", e));
  }

  return cachedP3Map;
}

async function getP4Map(): Promise<DateDrawsMapP4> {
  const leut = getLastExpectedUpdateTime();
  if (cachedP4Map && lastP4Fetch >= leut) return cachedP4Map;

  console.log(`[data] Refrescando mapa P4 (Evento: ${lastP4Fetch < leut ? "Nuevo sorteo disponible" : "Inicio"})`);
  const res = await fetch(P4_PDF_URL, { headers: { "User-Agent": "FloridaLotteryBot/1.0" } });
  if (!res.ok) throw new Error(`P4 PDF ${res.status}`);
  const data = await res.arrayBuffer();
  const txt = await pdfToText(data);
  cachedP4Map = parseP4FullText(txt);
  lastP4Fetch = Date.now();

  if (process.env.DATABASE_URL) {
    import("./infrastructure/database/PostgresDrawRepository.js")
      .then(m => m.saveDrawsToDB("p4", cachedP4Map!))
      .catch(e => console.error("Error guardando P4 en Postgres:", e));
  }

  return cachedP4Map;
}

/** Invalidates PDF caches so the next getP3Map/getP4Map call re-fetches from floridalottery.com */
function forceInvalidateCache() {
  lastP3Fetch = 0;
  lastP4Fetch = 0;
}

async function main(): Promise<void> {
  if (process.env.PORT && !WEBHOOK_URL) {
    console.error("En este entorno debes definir WEBHOOK_URL (ej: https://tu-app.onrender.com).");
    process.exit(1);
  }

  // ── DEBUGGING: Capturar errores críticos y servirlos en /health ──
  // Como no podemos ver los logs de Render ahora mismo, esto nos dirá qué falló al instante.
  (global as any)._lastBotError = "NINGUNO";
  process.on('uncaughtException', (err) => {
    (global as any)._lastBotError = err.stack || err.message;
    console.error("UNCAUGHT EXCEPTION:", (global as any)._lastBotError);
  });
  process.on('unhandledRejection', (reason) => {
    (global as any)._lastBotError = String(reason);
    console.error("UNHANDLED REJECTION:", (global as any)._lastBotError);
  });

  // ── Auto-draw handler (bound to live bot deps) ────────────────────────────
  const handleAutoDraw = createAutoDrawHandler({
    getP3Map,
    getP4Map,
    botApi: bot.api,
    forceInvalidateCache,
    getExtraMenuLabel,
    buildMainKeyboard: buildMainKb,
    getHotThresholdDays: () => hotThresholdDays,
  });

  // ── CRITICAL: Levantar HTTP server PRIMERO para que Render health check pase ──
  let server: ReturnType<typeof createServer> | null = null;
  if (WEBHOOK_URL) {
    const webhookPath = "/webhook";
    const autoDrawSecret = process.env.AUTO_DRAW_SECRET || "";
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("Status: OK. LastError: " + ((global as any)._lastBotError || "None"));
        return;
      }
      // ── /api/auto-draw — lottery-monitor webhook ─────────────────────────
      if (req.method === "POST" && req.url === "/api/auto-draw") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          let body: AutoDrawRequest;
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as AutoDrawRequest;
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            return;
          }
          // Verify shared secret
          if (autoDrawSecret && body.secret !== autoDrawSecret) {
            res.writeHead(403, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Forbidden" }));
            return;
          }
          const period = body.period;
          if (period !== "m" && period !== "e") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "period must be 'm' or 'e'" }));
            return;
          }
          handleAutoDraw(body)
            .then((result) => {
              console.log(`[AUTO-DRAW] ✅ found=${result.found} P3=${result.p3 ?? "-"} P4=${result.p4 ?? "-"} users=${result.usersNotified ?? 0}`);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify(result));
            })
            .catch((e) => {
              console.error("[AUTO-DRAW] ❌ Unhandled error:", e);
              res.writeHead(500, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ found: false, message: String(e) }));
            });
        });
        req.on("error", () => { res.writeHead(500); res.end(); });
        return;
      }

      // ── /hit — Custom Webhook ────────────────────────────
      // Guard: track which date|period pairs have already fired the combined push
      // to avoid sending it twice if the external monitor retries the same draw.
      if (req.url === "/hit") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", async () => {
          try {
            const body = Buffer.concat(chunks).toString("utf8");
            const payload = JSON.parse(body);
            console.log(`[HIT WEBHOOK] [${req.method}] Received data:`, payload);

            const secretToken = process.env.AUTO_DRAW_SECRET || "BLISS_FORENSIC_SECURE_TOKEN_2026";
            if (payload.secret !== secretToken) {
              res.writeHead(403, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "error", message: "Forbidden" }));
              return;
            }

            const { date, game, period, numbers } = payload;
            if (!date || !game || !period || !numbers) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "error", message: "Missing required fields" }));
              return;
            }

            const { saveDrawsToDB } = await import("./infrastructure/database/PostgresDrawRepository.js");
            const numsArr = numbers.split(",").map(Number);
            await saveDrawsToDB(game, {
              [date]: { [period]: numsArr }
            });

            const { saveHoyResult, getTodayEST } = await import("./hoy-results.js");
            if (date === getTodayEST()) {
              const gameKey = `${game}_${period}` as keyof import("./hoy-results.js").HoyResult;
              saveHoyResult({ [gameKey]: numbers.replace(/,/g, "") });
              console.log(`[HIT WEBHOOK] Sorteo integrado en 'Hoy' (hoy-results.json) [${gameKey}]`);
            }

            // ── Check if BOTH p3 AND p4 are now saved so we can fire a single push ──
            const { getDbPool } = await import("./infrastructure/database/PostgresConnection.js");
            const pool = getDbPool();
            const { rows: bothRows } = await pool.query(
              `SELECT game, numbers FROM draws WHERE date = $1 AND period = $2 AND game IN ('p3', 'p4')`,
              [date, period]
            );

            if (bothRows.length < 2) {
              console.log(`[HIT WEBHOOK] ⏳ Esperando el otro juego para fecha ${date} periodo ${period}. Recibidos: ${bothRows.map((r: any) => r.game).join(", ")}`);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "pending", message: "Saved. Waiting for the other draw to fire combined push." }));
              return;
            }

            // De-duplicate: skip if this date|period combo was already pushed
            const pairKey = `${date}|${period}`;
            if (hitNotifiedPairs.has(pairKey)) {
              console.log(`[HIT WEBHOOK] ⚠️ Push ya enviado para ${pairKey} — ignorando duplicado.`);
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ status: "already_sent", message: "Combined push was already fired for this draw." }));
              return;
            }
            hitNotifiedPairs.add(pairKey);

            // We have both — build a combined notification
            const p3Row = bothRows.find((r: any) => r.game === "p3");
            const p4Row = bothRows.find((r: any) => r.game === "p4");
            const p3Str = (p3Row?.numbers ?? "").replace(/,/g, "");
            const p4Str = (p4Row?.numbers ?? "").replace(/,/g, "");

            const { findWinningStrategies } = await import("./neuro-hit-engine.js");
            const { getExtraMenuLabel } = await import("./menu-registry.js");
            const { escapeMd } = await import("./security/callbacks.js");

            const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
            const formatVal = (v: string) => v.split("").join("-");
            const formatHits = (hits: { id: string; label: string }[]) => {
              if (hits.length === 0) return `\n\n⚡ *Algoritmos Validados:* _Recalibrando análisis predictivo..._`;
              const uniqueLabels = [...new Set(hits.map((h) => escapeMd(getExtraMenuLabel(h.label) || h.label)))];
              return `\n\n⚡ *Algoritmos Validados:*\n` + uniqueLabels.map((l) => ` ➥ ${l}`).join("\n");
            };

            let hitsP3: any[] = [];
            let hitsP4: any[] = [];
            try {
              const winningHits = await findWinningStrategies({ getP3Map, getP4Map }, hotThresholdDays);
              hitsP3 = winningHits[period === "m" ? "p3_m" : "p3_e"] ?? [];
              hitsP4 = winningHits[period === "m" ? "p4_m" : "p4_e"] ?? [];
            } catch (e) {
              console.warn(`[HIT WEBHOOK] ⚠️ findWinningStrategies failed:`, e);
            }

            const safeDate = date.replace(/\//g, "-");
            let notification = `🤖 *Sorteo Detectado: ${periodLabel}*\n📅 *Fecha:* ${date}\n\n`;
            if (p3Str) notification += `🎯 Pick 3 (Fijo): *${formatVal(p3Str)}*${formatHits(hitsP3)}\n\n`;
            if (p4Str) notification += `🎲 Pick 4 (Corrido): *${formatVal(p4Str)}*${formatHits(hitsP4)}\n`;
            notification += "\nConsulta todos los detalles en ☀️🌙 Últimos Sorteos 🏆";

            const adminKb = new InlineKeyboard().text("📢 Publicar", `hit_pub_all_${period}_${safeDate}`);

            for (const oid of getOwnerIds()) {
              bot.api.sendMessage(oid, notification, { parse_mode: "Markdown", reply_markup: adminKb }).catch(() => { });
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", message: "Both draws received — combined push sent to admins." }));

          } catch (e) {
            console.error("[HIT WEBHOOK] Error processing payload:", e);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "error", message: "Internal Error" }));
          }
        });
        req.on("error", (err) => {
          console.error("[HIT WEBHOOK] Request error:", err);
          res.writeHead(500);
          res.end();
        });
        return;
      }

      if (req.method === "POST" && req.url === webhookPath) {
        const secretToken = process.env.SECRET_TOKEN;
        if (secretToken) {
          const incomingToken = req.headers["x-telegram-bot-api-secret-token"];
          if (incomingToken !== secretToken) {
            res.writeHead(403, { "Content-Type": "text/plain" });
            res.end("Forbidden");
            return;
          }
        }
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          let update: Update;
          try {
            update = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Update;
          } catch {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Bad Request");
            return;
          }
          res.writeHead(200);
          res.end();
          bot.handleUpdate(update).catch((e) => console.error("Webhook handleUpdate error:", e));
        });
        req.on("error", () => {
          res.writeHead(500);
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(PORT);
    console.log(`[server] HTTP server escuchando en puerto ${PORT} (health check activo)`);
  }

  // Inicia crons — DB sync (si DATABASE_URL) + backup window polls (siempre)
  import("./infrastructure/cron/CronRunner.js")
    .then(c => c.initCronJobs(async (period) => {
      await handleAutoDraw({ period });
    }))
    .catch(e => console.error("Error iniciando crons:", e));

  registerExtraMenus();
  setSheetMenuLabelResolver(getExtraMenuLabel);
  await initUserConfig();
  // PG-first: carga estrategias y planes desde PostgreSQL
  {
    let rows = await loadStrategiesFromDB();
    const migrated = rows.some((r: any) => r.id === "estrategia_test");
    if (migrated) {
      rows = rows.map((r: any) =>
        r.id === "estrategia_test"
          ? {
            id: "max_per_week_day",
            titulo: "Más salidores x dia de la Semana",
            descripcion: "Números que más han salido x cada dia de la semana",
            createdBy: r.createdBy,
            price: r.price,
            visibility: r.visibility,
          }
          : r
      );
      await saveStrategiesToDB(rows);
    }
    initCustomMenusFromDB(rows);
    setStrategyDbPersist((menus) =>
      saveStrategiesToDB(
        menus.map((m) => ({
          id: m.id,
          titulo: m.label,
          descripcion: m.description ?? "",
          createdBy: m.createdBy ?? 0,
          price: m.price ?? "",
          visibility: m.visibility ?? "private",
          subscribers: m.subscribers ?? 0,
        }))
      )
    );
    const planRows = await loadPlansFromDB();
    if (planRows.length > 0) {
      setPlanDbPersist((items) => savePlansToDB(items));
      // Auto-update descripciones de planes por defecto
      let modified = false;
      const defaults = new Map([
        ["basico", "Resultados diarios + Estadísticas esenciales (frecuencias, alzas y atrasos) para jugar inteligentemente."],
        ["pro", "Plan Básico + Top 10 Hot, rachas, ciclos y análisis avanzado para maximizar tus aciertos. Ya puedes comercializar tus estrategias en la tienda"],
        ["trial", "Explora gratis todo el potencial de Ball Bot por 7 días y transforma tu forma de jugar."]
      ]);

      for (const row of planRows) {
        if (defaults.has(row.id) && row.description !== defaults.get(row.id)) {
          row.description = defaults.get(row.id)!;
          modified = true;
        }
      }

      initPlansFromDB(planRows);

      // Si los planes estaban duplicados (porque planRows tiene menos elementos que la hoja original
      // gracias al Set deduplicador de loadPlansFromDB) o si se modificó alguna descripción:
      if (modified) {
        await savePlansToDB(planRows);
        console.log("[plans] Sincronizadas descripciones actualizadas (y desduplicadas) a PostgreSQL.");
      }
    } else {
      initPlans();
      const plansToSave = getPlans().map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description ?? "",
        price: p.price ?? "",
        menuIds: (p.menuIds ?? []).join(","),
        price_1m: p.price_1m ?? "",
        price_3m: p.price_3m ?? "",
        price_6m: p.price_6m ?? "",
        price_9m: p.price_9m ?? "",
        price_1a: p.price_1a ?? "",
        autoApprove: p.autoApprove ? "true" : "",
      }));
      await savePlansToDB(plansToSave);
      setPlanDbPersist((items) => savePlansToDB(items));
    }
  }
  // 1. Sembrar estrategias integradas (NUEVO ORDEN: antes del registro de handlers)
  // Esto asegura que BUILT_IN_STRATEGIES existan en el catálogo antes de iterar
  await seedBuiltInStrategies(getOwnerIds());

  // 2. Registrar menús base del sistema (ej: est_grupos)
  registerExtraMenus();

  for (const m of getCustomMenus()) {
    // Protección BLISS: Si el ID ya está registrado con un handler real (ej: est_grupos), NO lo sobreescribimos.
    if (getExtraMenuStatus(m.id) === "implemented") {
      continue;
    }

    if (hasStrategyRunner(m.id)) {
      registerExtraMenu(
        m.id,
        m.label,
        async (ctx) => {
          await showStrategyContextSelection(ctx, m.id);
        },
        { description: m.description, isPlaceholder: false }
      );
    } else {
      registerExtraMenu(m.id, m.label, (ctx) => placeholderMenuHandler(ctx), {
        description: m.description,
        isPlaceholder: true,
      });
    }
  }

  loadStrategyPreviews();

  if (!process.env.DATABASE_URL) {
    initPlans();
  }

  await normalizeUserMenusAfterLoad();
  await bot.init();

  /* Precarga única: lectura de los PDF y extracción de los mapas de fechas. El caché de candidatos ahora es MANUAL. */
  Promise.all([getP3Map(), getP4Map()])
    .catch((e) => console.error("Preload Error:", e));

  await bot.api.setMyCommands([
    { command: "start", description: "Iniciar y ver opciones" },
    { command: "help", description: "Ver ayuda" },
    { command: "cancel", description: "Cancelar y volver al menú" },
  ]);

  if (WEBHOOK_URL) {
    const webhookPath = "/webhook";
    const fullUrl = `${WEBHOOK_URL.replace(/\/$/, "")}${webhookPath}`;
    await bot.api.setWebhook(fullUrl, {
      secret_token: process.env.SECRET_TOKEN || undefined,
    });
    console.log(`[webhook] Registrado: ${fullUrl}`);
    // Server HTTP ya está escuchando desde el inicio de main()
  } else {
    await bot.start();
  }
}

main().catch(console.error);
