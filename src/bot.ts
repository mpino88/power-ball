/**
 * Bot de Telegram: Florida Lottery Pick 3 y Pick 4 — resultados desde los PDF oficiales.
 * Arquitectura por módulos: security (acceso, administración), menus (teclados y callbacks).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Bot, InlineKeyboard } from "grammy";
import type { Update } from "grammy/types";
import {
  getOwnerId,
  isAllowed,
  getExtraMenus,
  isOwner,
  initUserConfig,
  addPlanRequest,
} from "./user-config.js";
import {
  registerExtraMenu,
  getHandler,
  getExtraMenuLabel,
  getExtraMenuIds,
  EXTRA_MENU_CALLBACK_PREFIX,
} from "./menu-registry.js";
import { initCustomMenus } from "./custom-menus.js";
import { initPlans } from "./plans.js";
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
  handleSecurityMessage,
  buildSecurityKeyboard,
  buildManagePlansKeyboard,
  clearAllFlows,
  creatingPlanFlow,
  editingPlanFlow,
} from "./security/index.js";
import {
  buildMainKeyboard,
  buildEstadisticasKeyboard,
  buildIndividualPeriodKeyboard,
  handleMenuCallback,
  type GameMenu,
} from "./menus/index.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";
const FLORIDA_TZ = "America/New_York";
const REQUEST_ACCESS_LINK = process.env.REQUEST_ACCESS_LINK?.trim() ?? "";

const HELP_TEXT =
  "📋 *Ayuda — Plan Básico*\n\n" +
  "Ud. posee un *plan Básico*: le brindamos algunas estadísticas y consultas.\n\n" +
  "Si requiere implementar su propia solución con un costo adicional, contacte al administrador.\n\n" +
  "Note que esas funciones las podrá comercializar con otros usuarios a través de la aplicación y por medio del admin.";

let hotThresholdDays = 5;
const waitingCustomDateGame = new Map<number, GameMenu>();

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
  getExtraMenus,
  getExtraMenuIds,
  getExtraMenuLabel,
};

function buildMainKb(userId: number | undefined) {
  return buildMainKeyboard(userId, mainKbDeps);
}

/** Handler para menús creados por el dueño que aún no tienen lógica en código. */
async function placeholderMenuHandler(ctx: {
  answerCallbackQuery: () => Promise<unknown>;
  editMessageText: (text: string, opts?: object) => Promise<unknown>;
  from?: { id: number };
}): Promise<void> {
  await ctx.answerCallbackQuery();
  try {
    await ctx.editMessageText("🚧 Esta función está en desarrollo.", {
      parse_mode: "Markdown",
      reply_markup: buildMainKb(ctx.from?.id),
    });
  } catch (e) {
    if (!(e as Error).message?.includes("message is not modified")) console.error(e);
  }
}

function registerExtraMenus(): void {
  registerExtraMenu("est_grupos", "📊 Est. grupos", async (ctx) => {
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
  });
  registerExtraMenu("est_individuales", "📈 Est. individuales", async (ctx) => {
    await ctx.answerCallbackQuery();
    const result =
      "📈 *Top 10 más Hot* (números 00-99)\n\nElige *Mediodía (M)* o *Noche (E)*. 🔥 Hot = (Máx.hist − Máx.actual) ≤ Días diferencia.";
    try {
      await ctx.editMessageText(result, {
        parse_mode: "Markdown",
        reply_markup: buildIndividualPeriodKeyboard(hotThresholdDays),
      });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
  });
}

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
  await ctx.reply(HELP_TEXT, {
    parse_mode: "Markdown",
    reply_markup: buildMainKb(ctx.from?.id),
  });
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

  const menuDeps = {
    ...mainKbDeps,
    helpText: HELP_TEXT,
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

  if (data.startsWith(EXTRA_MENU_CALLBACK_PREFIX)) {
    const menuId = data.slice(EXTRA_MENU_CALLBACK_PREFIX.length);
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
    onMenuCreated: (id, label) => {
      registerExtraMenu(id, label, (c) => placeholderMenuHandler(c));
    },
  });
  if (securityHandled) return;

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

  await initUserConfig();
  initPlans();
  registerExtraMenus();
  for (const m of initCustomMenus()) {
    registerExtraMenu(m.id, m.label, (ctx) => placeholderMenuHandler(ctx));
  }
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
