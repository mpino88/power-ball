/**
 * Bot de Telegram: Florida Lottery Pick 3 y Pick 4 — resultados desde los PDF oficiales.
 * Arquitectura por módulos: security (acceso, administración), menus (teclados y callbacks).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Bot, InlineKeyboard } from "grammy";
import type { Update } from "grammy/types";
import {
  getOwnerId,
  getOwnerIds,
  isAllowed,
  getExtraMenus,
  getPlan,
  getPendingPlan,
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
  loadStrategiesFromSheet,
  saveStrategiesToSheet,
  loadPlansFromSheet,
  savePlansToSheet,
  normalizeUserMenusAfterLoad,
  loadTestingCutoffDate,
  saveTestingCutoffDate,
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
  initCustomMenusFromSheet,
  setStrategySheetPersist,
  getCustomMenus,
  getMenuCreatedBy,
  getMenuSubscribers,
  seedCustomMenus,
} from "./custom-menus.js";
import { initPlans, initPlansFromSheet, setPlanSheetPersist, getPlans, getPlanById, getPlanByTitle } from "./plans.js";
import {
  buildGroupStatsMessage as buildGroupStatsMessageFromStats,
  buildIndividualTop10Message as buildIndividualTop10MessageFromStats,
} from "./stats-p3.js";
import {
  scrapeTodayPick3,
  scrapeTodayPick4,
  type TodayScrapeResult,
} from "./florida-lottery.js";
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
  handleMenuCallback,
  ESTRATEGIAS_OPEN_CALLBACK,
  type GameMenu,
} from "./menus/index.js";
import {
  buildStrategyContextKeyboard,
  getStrategyContextMessage,
  parseStrategyContextCallback,
  runStrategy,
  hasStrategyRunner,
  getStrategy,
  getConsensusSelectableIds,
} from "./strategies/index.js";
import { filterMapByCutoff, getNextDrawResult, buildTestingVerificationBlock } from "./strategies/utils.js";
import { STRATEGY_CONTEXT_CALLBACK_PREFIX } from "./strategies/types.js";
import {
  runConsensusAggregation,
  buildConsensusSelectionKeyboard,
  buildConsensusSelectionMessage,
} from "./strategies/consensus-multi.js";
import type { StrategyContext } from "./strategies/types.js";
import {
  buildCharadaMenuKeyboard,
  buildCharadaCatalogKeyboard,
  buildCatalogPage,
  searchCharada,
  buildSearchMessage,
} from "./charada.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";
const FLORIDA_TZ = "America/New_York";
const REQUEST_ACCESS_LINK = process.env.REQUEST_ACCESS_LINK?.trim() ?? "";

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
}
const consensusSessionMap = new Map<number, ConsensusSession>();

/** Usuarios que están esperando introducir una búsqueda en la Charada. */
const waitingCharadaSearch = new Map<number, true>();

/**
 * Caché de la fecha de corte de testing (5 min).
 * Lee la celda A2 de la pestaña "Testing" (índice 4) del Sheet.
 * null = sin corte (usar base completa).
 */
const TESTING_CUTOFF_TTL_MS = 5 * 60 * 1000;
let cachedTestingCutoff: { at: number; date: string | null } | null = null;

async function getTestingCutoff(): Promise<string | null> {
  const now = Date.now();
  if (cachedTestingCutoff && now - cachedTestingCutoff.at < TESTING_CUTOFF_TTL_MS) {
    return cachedTestingCutoff.date;
  }
  const date = await loadTestingCutoffDate();
  cachedTestingCutoff = { at: now, date };
  if (date) console.log(`[testing] Fecha de corte activa: ${date}`);
  return date;
}

/** Invalida la caché de cutoff para que la próxima lectura vaya al Sheet. */
function invalidateTestingCutoffCache(): void {
  cachedTestingCutoff = null;
}

/** Usuarios (solo el dueño) esperando introducir una fecha de testing. */
const waitingTestingDate = new Map<number, true>();

/**
 * Versiones de getP3Map/getP4Map con filtro de fecha de corte para estrategias.
 * El filtro solo aplica al dueño del bot; cualquier otro usuario recibe el mapa completo.
 */
async function getStrategyP3Map(userId?: number): Promise<DateDrawsMap> {
  const map = await getP3Map();
  if (!isOwner(userId ?? 0)) return map;
  const cutoff = await getTestingCutoff();
  return cutoff ? filterMapByCutoff(map, cutoff) : map;
}

async function getStrategyP4Map(userId?: number): Promise<DateDrawsMap> {
  const map = await getP4Map();
  if (!isOwner(userId ?? 0)) return map as DateDrawsMap;
  const cutoff = await getTestingCutoff();
  return cutoff ? filterMapByCutoff(map as DateDrawsMap, cutoff) : (map as DateDrawsMap);
}

/** Caché del scrape "Hoy" (10 min); solo la fuente PDF se precarga, el resto es on demand. */
const HOY_CACHE_TTL_MS = 10 * 60 * 1000;
let cachedScrapeToday: {
  at: number;
  p3: TodayScrapeResult;
  p4: TodayScrapeResult;
} | null = null;

/** En Render (o DISABLE_PUPPETEER) no se usa navegador; "Hoy" se obtiene del PDF oficial. */
const PUPPETEER_DISABLED =
  process.env.RENDER === "true" || process.env.DISABLE_PUPPETEER === "true";

async function getCachedScrapeToday(): Promise<{
  p3: TodayScrapeResult;
  p4: TodayScrapeResult;
}> {
  const now = Date.now();
  if (cachedScrapeToday && now - cachedScrapeToday.at < HOY_CACHE_TTL_MS) {
    return { p3: cachedScrapeToday.p3, p4: cachedScrapeToday.p4 };
  }

  if (PUPPETEER_DISABLED) {
    const todayKey = getTodayFloridaMMDDYY();
    const [map3, map4] = await Promise.all([getP3Map(), getP4Map()]);
    const d3 = map3[todayKey] ?? {};
    const d4 = map4[todayKey] ?? {};
    const hasToday = !!((d3.m || d3.e) && (d4.m || d4.e));
    const p3: TodayScrapeResult = { isToday: hasToday, key: todayKey, m: d3.m, e: d3.e };
    const p4: TodayScrapeResult = { isToday: hasToday, key: todayKey, m: d4.m, e: d4.e };
    cachedScrapeToday = { at: now, p3, p4 };
    return { p3, p4 };
  }

  const [p3, p4] = await Promise.all([scrapeTodayPick3(), scrapeTodayPick4()]);
  cachedScrapeToday = { at: now, p3, p4 };
  return { p3, p4 };
}

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
        "📊 *Estadísticas por grupos* (Fijo P3)\n\nElige *Mediodía (M)* o *Noche (E)*. Grupos: terminales (0-9), iniciales (0-9), dobles.\n\n🔥 Hot = (Máx.hist − Máx.actual) ≤ Días diferencia.";
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
  {
    id: "consensus_multi",
    label: "Consenso Multi-Estrategia",
    description:
      "Cruza los candidatos de varias estrategias y devuelve los N números con mayor respaldo estadístico cruzado.",
  },
];

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
  })
);

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 Resultados *Fijo* (P3) y *Corrido* (P4) de Florida Lottery.\n\nElige juego y luego el período:",
    { parse_mode: "Markdown", reply_markup: buildMainKb(ctx.from?.id) }
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
  await ctx.reply("🔒 *Seguridad* — Gestiona quién puede usar el bot y sus menús.", {
    parse_mode: "Markdown",
    reply_markup: buildSecurityKeyboard(),
  });
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  let result: string;
  let keyboard: InlineKeyboard = buildMainKb(ctx.from?.id);
  const asyncData =
    /^(fijo|corrido|ambos)_(hoy|ayer|semana)$/.test(data) ||
    data === "stats_grupos_M" ||
    data === "stats_grupos_E" ||
    data === "stats_individual_M" ||
    data === "stats_individual_E" ||
    (data.startsWith(EXTRA_MENU_CALLBACK_PREFIX) && !!getHandler(data.slice(EXTRA_MENU_CALLBACK_PREFIX.length)));

  if ((data === "security_open" || data === "security_main" || data.startsWith("admin_")) && ctx.from && isOwner(ctx.from.id)) {
    const out = await handleSecurityCallback(ctx, data, {
      buildMainKeyboard: buildMainKb,
      getExtraMenuIds,
      getExtraMenuLabel,
      getStorageBackend,
      loadPlansFromSheet,
      initPlansFromSheet,
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
      const current = await loadTestingCutoffDate();
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
        await saveTestingCutoffDate(null);
        invalidateTestingCutoffCache();
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
    waitingTestingDate.delete(ctx.from.id);
    await ctx.answerCallbackQuery({ text: "Cancelado" });
    const current = await loadTestingCutoffDate();
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

  if (data === ESTRATEGIAS_OPEN_CALLBACK) {
    await ctx.answerCallbackQuery();
    const result = "➕ *Estrategias*\n\nElige una estrategia o gestiona las tuyas:";
    const keyboard = buildEstrategiasKeyboard(ctx.from?.id, mainKbDeps);
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  if (ctx.from && isAllowed(ctx.from.id) && (data === "estrategias_manage" || data === "estrategias_list" || data === "estrategias_tienda" || data.startsWith("estrategias_request_") || data === "estrategias_visibility" || data.startsWith("estrategias_visibility_toggle_") || data === "estrategias_create" || data === "estrategias_delete" || data.startsWith("estrategias_delete_"))) {
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
    const plans = getPlans();
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
    const pendingPlan = getPendingPlan(ctx.from.id);
    let headerMsg = "📋 *Cambiar de plan*\n\n";
    if (pendingPlan) {
      headerMsg += `_Ya tienes una solicitud pendiente para cambiar a *${escapeMd(pendingPlan)}*. Puedes elegir otro plan para reemplazarla._\n\n`;
    } else if (currentPlan) {
      headerMsg += `Plan actual: *${escapeMd(currentPlan)}*\n\n`;
    }
    headerMsg += "_Tu acceso actual se mantiene hasta que el administrador apruebe el cambio._";
    const keyboard = new InlineKeyboard();
    for (const p of plans) {
      keyboard.text(`${p.title} — ${p.price}`, `user_cambiar_plan_${p.id}`).row();
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
    const planId = data.slice("user_cambiar_plan_".length);
    const plan = getPlanById(planId);
    if (plan) {
      const currentPlan = getPlan(ctx.from.id);
      const res = await requestPlanChange(ctx.from.id, plan.title);
      await ctx.answerCallbackQuery({ text: res.ok ? "Solicitud enviada" : "Error" });
      const currentPlanNote = currentPlan
        ? `Sigues con tu plan *${escapeMd(currentPlan)}* hasta que el administrador apruebe el cambio.`
        : "_El administrador revisará tu solicitud._";
      try {
        await ctx.editMessageText(
          `✅ Has solicitado cambiar al plan *${escapeMd(plan.title)}*.\n\n${currentPlanNote}`,
          { parse_mode: "Markdown", reply_markup: buildMainKb(ctx.from.id) }
        );
      } catch (e) {
        if (!(e as Error).message?.includes("message is not modified")) console.error(e);
      }
    } else {
      await ctx.answerCallbackQuery({ text: "Plan no encontrado" });
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
    getP3Map,
    getP4Map,
    buildGroupStatsMessage: buildGroupStatsMessageFromStats,
    buildIndividualTop10Message: buildIndividualTop10MessageFromStats,
    getCachedScrapeToday,
    buildResultOneDay,
    buildResultWeek,
    getTodayFloridaMMDDYY,
    getYesterdayFloridaMMDDYY,
    getThisWeekFloridaMMDDYY,
  };

  const menuOut = await handleMenuCallback(ctx, data, menuDeps);
  if (menuOut) {
    try {
      await ctx.editMessageText(menuOut.result, { parse_mode: "Markdown", reply_markup: menuOut.keyboard });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!msg.includes("message is not modified")) console.error("Error en callback_query:", err);
    }
    return;
  }

  if (data.startsWith(STRATEGY_CONTEXT_CALLBACK_PREFIX)) {
    const parsed = parseStrategyContextCallback(data);
    if (parsed) {
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
          const selectableIds = getConsensusSelectableIds();
          const msg = buildConsensusSelectionMessage(0, parsed.context, selectableIds);
          const kb = buildConsensusSelectionKeyboard(new Set(), parsed.context, selectableIds);
          try {
            await ctx.editMessageText(msg, { parse_mode: "Markdown", reply_markup: kb });
          } catch (e) {
            if (!(e as Error).message?.includes("message is not modified")) console.error(e);
          }
        }
        return;
      }

      if (hasStrategyRunner(parsed.menuId)) {
        await ctx.answerCallbackQuery({ text: "Calculando…" });
        try {
          const userId = ctx.from?.id;
          const msg = await runStrategy(parsed.menuId, parsed.context, {
            getP3Map: () => getStrategyP3Map(userId),
            getP4Map: () => getStrategyP4Map(userId),
          });
          await ctx.editMessageText(msg, {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard().text("◀️ Volver", "volver"),
          });
          // Verificación testing: solo para dueños con fecha de corte activa
          if (userId && isOwner(userId)) {
            const cutoff = await getTestingCutoff();
            if (cutoff) {
              try {
                const isP3 = parsed.context.mapSource === "p3";
                const fullMap = isP3 ? await getP3Map() : (await getP4Map()) as DateDrawsMap;
                const nextResult = getNextDrawResult(fullMap, cutoff, parsed.context.period, parsed.context.mapSource);
                if (nextResult) {
                  const strat = getStrategy(parsed.menuId);
                  let candidates: number[] = [];
                  if (strat?.getCandidates) {
                    const filteredMap = isP3 ? await getStrategyP3Map(userId) : await getStrategyP4Map(userId);
                    candidates = await strat.getCandidates(parsed.context, filteredMap);
                  }
                  const verifBlock = buildTestingVerificationBlock(nextResult, candidates, parsed.context);
                  await ctx.reply(verifBlock, { parse_mode: "Markdown" });
                }
              } catch (verifErr) {
                console.error("[testing-verif] Error al generar verificación:", verifErr);
              }
            }
          }
        } catch (err) {
          console.error("Error runStrategy:", err);
          await ctx.answerCallbackQuery({ text: "Error al calcular" }).catch(() => {});
          try {
            await ctx.editMessageText("❌ Error al ejecutar la estrategia. Vuelve a intentarlo.", {
              reply_markup: buildMainKb(ctx.from?.id),
            });
          } catch (e) {
            if (!(e as Error).message?.includes("message is not modified")) console.error(e);
          }
        }
        return;
      }
    }
  }

  // ── Consenso: callbacks de selección ──────────────────────────────────────
  if (data.startsWith("cns_t_") && ctx.from) {
    const userId = ctx.from.id;
    const session = consensusSessionMap.get(userId);
    const stratId = data.slice("cns_t_".length);
    if (session && session.step === "selecting" && getConsensusSelectableIds().includes(stratId)) {
      if (session.selectedIds.has(stratId)) {
        session.selectedIds.delete(stratId);
      } else {
        session.selectedIds.add(stratId);
      }
      await ctx.answerCallbackQuery();
      const selectableIds = getConsensusSelectableIds();
      const msg = buildConsensusSelectionMessage(session.selectedIds.size, session.context, selectableIds);
      const kb = buildConsensusSelectionKeyboard(session.selectedIds, session.context, selectableIds);
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
            `¿Cuántos resultados quieres ver?\nEnvía un número del *1 al 20*.\n\n_Usa /cancel para cancelar._`,
          {
            parse_mode: "Markdown",
            reply_markup: new InlineKeyboard().text("❌ Cancelar", "cns_x"),
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

  if (data.startsWith(EXTRA_MENU_CALLBACK_PREFIX)) {
    const menuId = data.slice(EXTRA_MENU_CALLBACK_PREFIX.length);
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
        "🃏 *Charada Cubana*\n\nSistema de numerología popular cubano: 100 números \\(00–99\\) con sus significados tradicionales\\.\n\nElige una opción:",
        { parse_mode: "MarkdownV2", reply_markup: buildCharadaMenuKeyboard() }
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
          "• Escribe un *número* del `00` al `99` para ver su significado\\.\n" +
          "• Escribe una *palabra* \\(ej\\: `gato`, `agua`, `muerte`\\) para encontrar todas las entradas que la contengan\\.\n\n" +
          "👇 *Escribe tu búsqueda aquí abajo y pulsa Enviar*\n\n" +
          "_Usa /cancel para cancelar\\._",
        {
          parse_mode: "MarkdownV2",
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
        "🃏 *Charada Cubana*\n\nSistema de numerología popular cubano\\.\n\nElige una opción:",
        { parse_mode: "MarkdownV2", reply_markup: buildCharadaMenuKeyboard() }
      );
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  if (data === "charada_noop") {
    await ctx.answerCallbackQuery();
    return;
  }
  // ── fin Charada ────────────────────────────────────────────────────────────

  result = "Opción no reconocida. Usa /start para ver el menú.";
  try {
    if (!asyncData) await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch (err) {
    if (!asyncData) await ctx.answerCallbackQuery({ text: "Listo ✓" }).catch(() => {});
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
  });
  if (securityHandled) return;

  // ── Testing: entrada de fecha de corte (solo dueño) ───────────────────────
  if (userId && isOwner(userId) && waitingTestingDate.has(userId)) {
    waitingTestingDate.delete(userId);
    if (!/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(text)) {
      await ctx.reply(
        "❌ Formato inválido. Usa *MM/DD/YY* \\(ej: `12/31/25`\\)\\. Vuelve a intentarlo desde el menú\\.",
        { parse_mode: "MarkdownV2", reply_markup: buildMainKb(userId) }
      );
      return;
    }
    try {
      await saveTestingCutoffDate(text);
      invalidateTestingCutoffCache();
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

  // ── Consenso: entrada de cantidad de resultados ──────────────────────────
  const consensusSession = userId ? consensusSessionMap.get(userId) : undefined;
  if (userId && consensusSession?.step === "waiting_count") {
    consensusSessionMap.delete(userId);
    const count = parseInt(text, 10);
    if (Number.isNaN(count) || count < 1 || count > 20) {
      await ctx.reply("❌ Número no válido (debe ser entre 1 y 20). Usa /start para volver.", {
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
      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: buildMainKb(userId) });
      // Verificación testing: solo para dueños con fecha de corte activa
      if (isOwner(userId)) {
        const cutoff = await getTestingCutoff();
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

let cachedP3Map: DateDrawsMap | null = null;
let cachedP4Map: DateDrawsMapP4 | null = null;

async function getP3Map(): Promise<DateDrawsMap> {
  if (cachedP3Map) return cachedP3Map;
  const res = await fetch(P3_PDF_URL, { headers: { "User-Agent": "FloridaLotteryBot/1.0" } });
  if (!res.ok) throw new Error(`P3 PDF ${res.status}`);
  const txt = await pdfToText(await res.arrayBuffer());
  cachedP3Map = parseP3FullText(txt);
  return cachedP3Map;
}

async function getP4Map(): Promise<DateDrawsMapP4> {
  if (cachedP4Map) return cachedP4Map;
  const res = await fetch(P4_PDF_URL, { headers: { "User-Agent": "FloridaLotteryBot/1.0" } });
  if (!res.ok) throw new Error(`P4 PDF ${res.status}`);
  const txt = await pdfToText(await res.arrayBuffer());
  cachedP4Map = parseP4FullText(txt);
  return cachedP4Map;
}

async function main(): Promise<void> {
  if (!BOT_TOKEN) {
    console.error("Configura TELEGRAM_BOT_TOKEN en el entorno.");
    process.exit(1);
  }
  if (process.env.PORT && !WEBHOOK_URL) {
    console.error("En este entorno debes definir WEBHOOK_URL (ej: https://tu-app.onrender.com).");
    process.exit(1);
  }

  registerExtraMenus();
  setSheetMenuLabelResolver(getExtraMenuLabel);
  await initUserConfig();
  if (getStorageBackend() === "sheet") {
    let rows = await loadStrategiesFromSheet();
    const migrated = rows.some((r) => r.id === "estrategia_test");
    if (migrated) {
      rows = rows.map((r) =>
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
      await saveStrategiesToSheet(rows);
    }
    initCustomMenusFromSheet(rows);
    setStrategySheetPersist((menus) =>
      saveStrategiesToSheet(
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
    const planRows = await loadPlansFromSheet();
    if (planRows.length > 0) {
      setPlanSheetPersist((items) => savePlansToSheet(items));
      initPlansFromSheet(planRows);
    } else {
      initPlans();
      const plansToSave = getPlans().map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description ?? "",
        price: p.price ?? "",
        menuIds: (p.menuIds ?? []).join(","),
      }));
      await savePlansToSheet(plansToSave);
      setPlanSheetPersist((items) => savePlansToSheet(items));
    }
  } else {
    initCustomMenus();
  }
  for (const m of getCustomMenus()) {
    if (hasStrategyRunner(m.id)) {
      registerExtraMenu(
        m.id,
        m.label,
        async (ctx) => {
          await ctx.answerCallbackQuery();
          const label = getExtraMenuLabel(m.id) ?? m.label;
          const text = getStrategyContextMessage(m.id, label);
          const keyboard = buildStrategyContextKeyboard(m.id);
          try {
            await ctx.editMessageText(text, { parse_mode: "Markdown", reply_markup: keyboard });
          } catch (e) {
            if (!(e as Error).message?.includes("message is not modified")) console.error(e);
          }
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
  if (getStorageBackend() !== "sheet") {
    initPlans();
  }

  // Seed built-in strategies and assign them to the owner before registering menus.
  await seedBuiltInStrategies(getOwnerIds());

  await normalizeUserMenusAfterLoad();
  await bot.init();

  /* Precarga única: lectura de los PDF y extracción de los mapas de fechas. El resto se calcula on demand. */
  Promise.all([getP3Map(), getP4Map()]).catch((e) => console.error("Preload PDF:", e));

  await bot.api.setMyCommands([
    { command: "start", description: "Iniciar y ver opciones" },
    { command: "help", description: "Ver ayuda" },
    { command: "cancel", description: "Cancelar y volver al menú" },
  ]);

  if (WEBHOOK_URL) {
    const webhookPath = "/webhook";
    const fullUrl = `${WEBHOOK_URL.replace(/\/$/, "")}${webhookPath}`;
    await bot.api.setWebhook(fullUrl);
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
        return;
      }
      if (req.method === "POST" && req.url === webhookPath) {
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
  } else {
    await bot.start();
  }
}

main().catch(console.error);
