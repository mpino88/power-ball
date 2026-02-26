/**
 * Bot de Telegram con menú de botones y procesamiento.
 * Ejemplo: generación de números tipo Power Ball y cálculos.
 * Soporta webhook (para Render u otro hosting gratis) y long polling (local).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import type { DateFilter, DrawPeriod } from "./florida-lottery.js";
import {
  fetchPick3Results,
  fetchPick4Results,
  fetchAllDrawsFromPdf,
  getPdfPageCounts,
  formatDateForLabel,
  formatAllReadForBot,
  formatResultsForBot,
} from "./florida-lottery.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? ""; // ej: https://tu-bot.onrender.com

const HELP_TEXT =
  "🎱 *Generar números*\nSimula una combinación tipo Power Ball: 5 números (1-69) + Power Ball (1-26).\n\n" +
  "📊 *Calcular probabilidad*\nProbabilidad de acertar el jackpot (1 entre ~292 millones).\n\n" +
  "🏝 *Pick 3 / Pick 4 Florida*\nResultados por *Hoy*, *Ayer* o *Fecha custom*. *Todo PDF*: todo lo leído del PDF oficial.\n\n" +
  "🔄 *Otra combinación*\nGenera una nueva combinación.\n\n" +
  "Usa los botones o escribe /start para ver el menú.";

/** Usuarios esperando escribir una fecha: game y periodo (E/M). */
const waitingCustomDate = new Map<
  number,
  { game: "pick3" | "pick4"; period: "evening" | "midday" }
>();

/** Convierte año 2 dígitos a 4 (25 → 2026, 99 → 1999). */
function fullYear(yy: number): number {
  if (yy >= 0 && yy <= 99) return yy >= 50 ? 1900 + yy : 2000 + yy;
  return yy;
}

/** Valida que month 1–12 y day 1–31 y que el día exista en ese mes. */
function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(year, month, 0).getDate();
  return day <= daysInMonth;
}

/** Parsea fecha escrita por el usuario. Formatos: YYYY-MM-DD, MM/DD/YY, DD/MM/YY, MM/DD/YYYY, DD/MM/YYYY. */
function parseUserDate(text: string): Date | null {
  const t = text.trim();
  const dash = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
  const slash4 = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$|^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
  const slash2 = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/; // MM/DD/YY o DD/MM/YY
  let m = t.match(dash);
  if (m) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    if (!isValidCalendarDate(y, mo, d)) return null;
    const date = new Date(y, mo - 1, d);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  m = t.match(slash2);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    const year = fullYear(parseInt(m[3], 10));
    let month: number;
    let day: number;
    if (a > 12) {
      day = a;
      month = b;
    } else if (b > 12) {
      month = a;
      day = b;
    } else {
      month = a;
      day = b;
    }
    if (!isValidCalendarDate(year, month, day)) return null;
    const date = new Date(year, month - 1, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  m = t.match(slash4);
  if (m) {
    if (m[4]) {
      const y = parseInt(m[4], 10);
      const mo = parseInt(m[5], 10);
      const d = parseInt(m[6], 10);
      if (!isValidCalendarDate(y, mo, d)) return null;
      const date = new Date(y, mo - 1, d);
      return Number.isNaN(date.getTime()) ? null : date;
    }
    const y = parseInt(m[3], 10);
    const mo = parseInt(m[2], 10);
    const d = parseInt(m[1], 10);
    if (!isValidCalendarDate(y, mo, d)) return null;
    const date = new Date(y, mo - 1, d);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function buildMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎱 Generar números", "generate")
    .text("📊 Calcular probabilidad", "probability")
    .row()
    .text("🌙 E — Fijo Hoy", "fl_p3_hoy_e")
    .text("E Fijo Ayer", "fl_p3_ayer_e")
    .text("E Fijo Fecha", "fl_p3_fecha_e")
    .text("E Fijo Todo", "fl_p3_todo_e")
    .row()
    .text("🌙 E — Corrido Hoy", "fl_p4_hoy_e")
    .text("E Corrido Ayer", "fl_p4_ayer_e")
    .text("E Corrido Fecha", "fl_p4_fecha_e")
    .text("E Corrido Todo", "fl_p4_todo_e")
    .row()
    .text("☀️ M — Fijo Hoy", "fl_p3_hoy_m")
    .text("M Fijo Ayer", "fl_p3_ayer_m")
    .text("M Fijo Fecha", "fl_p3_fecha_m")
    .text("M Fijo Todo", "fl_p3_todo_m")
    .row()
    .text("☀️ M — Corrido Hoy", "fl_p4_hoy_m")
    .text("M Corrido Ayer", "fl_p4_ayer_m")
    .text("M Corrido Fecha", "fl_p4_fecha_m")
    .text("M Corrido Todo", "fl_p4_todo_m")
    .row()
    .text("📄 Páginas PDF P3 y P4", "fl_pdf_pages")
    .row()
    .text("🔄 Otra combinación", "generate")
    .text("❓ Ayuda", "help");
}

// --- Procesamiento ---

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function processGenerateNumbers(): string {
  const white = shuffle(Array.from({ length: 69 }, (_, i) => i + 1))
    .slice(0, 5)
    .sort((a, b) => a - b);
  const power = Math.floor(Math.random() * 26) + 1;
  return (
    `*Tus números:*\n\`${white.join(" - ")}\`  |  *Power Ball:* \`${power}\`\n\n_¡Buena suerte! 🍀_`
  );
}

function comb(n: number, k: number): number {
  if (k > n || k < 0) return 0;
  let num = 1;
  let den = 1;
  for (let i = 0; i < k; i++) {
    num *= n - i;
    den *= i + 1;
  }
  return num / den;
}

function processProbability(): string {
  const total = comb(69, 5) * 26;
  const prob = 1 / total;
  return (
    `*Probabilidad de jackpot:*\n` +
    `1 entre *${total.toLocaleString()}*\n\n` +
    `En decimal: ~${prob.toExponential(2)}`
  );
}

// --- Bot ---

const bot = new Bot(BOT_TOKEN);

bot.command("start", async (ctx) => {
  const welcome =
    "👋 *Hola!* Soy tu bot de Power Ball.\n\n" +
    "Puedo generar combinaciones aleatorias y mostrarte la probabilidad del jackpot.\n\n" +
    "Elige una opción:";
  await ctx.reply(welcome, {
    parse_mode: "Markdown",
    reply_markup: buildMainKeyboard(),
  });
});

bot.command("help", async (ctx) => {
  await ctx.reply(HELP_TEXT, {
    parse_mode: "Markdown",
    reply_markup: buildMainKeyboard(),
  });
});

async function handleFloridaDate(
  ctx: { answerCallbackQuery: (opts?: { text: string }) => Promise<unknown>; editMessageText: (text: string, opts: object) => Promise<unknown> },
  _data: string,
  dateFilter: DateFilter,
  game: "Pick 3" | "Pick 4",
  period: DrawPeriod,
  titleOverride?: string
): Promise<string> {
  await ctx.answerCallbackQuery({ text: `Consultando ${game}…` });
  try {
    const fetchResults = game === "Pick 3" ? fetchPick3Results : fetchPick4Results;
    const gameResults = await fetchResults(dateFilter);
    const filtered = {
      ...gameResults,
      draws: gameResults.draws.filter((d) => d.period === period),
    };
    return formatResultsForBot(filtered, titleOverride);
  } catch (e) {
    console.error(`${game} fetch error:`, e);
    return `No pude cargar los resultados de ${game}. Prueba más tarde o revisa en:\n[${game} – Florida Lottery](https://floridalottery.com/games/draw-games/${game === "Pick 3" ? "pick-3" : "pick-4"})`;
  }
}

async function handleFloridaTodo(
  ctx: { answerCallbackQuery: (opts?: { text: string }) => Promise<unknown> },
  game: "Pick 3" | "Pick 4",
  period: DrawPeriod
): Promise<string> {
  await ctx.answerCallbackQuery({ text: "Leyendo PDF…" });
  try {
    const draws = await fetchAllDrawsFromPdf(game);
    const filtered = draws.filter((d) => d.period === period);
    const officialLink =
      game === "Pick 3"
        ? "https://floridalottery.com/games/draw-games/pick-3"
        : "https://floridalottery.com/games/draw-games/pick-4";
    return formatAllReadForBot(game, filtered, officialLink);
  } catch (e) {
    console.error("Todo PDF fetch error:", e);
    return `No pude leer el PDF de ${game}. Prueba más tarde.\n\n[Florida Lottery](${game === "Pick 3" ? "https://floridalottery.com/games/draw-games/pick-3" : "https://floridalottery.com/games/draw-games/pick-4"})`;
  }
}

async function handlePdfPages(
  ctx: { answerCallbackQuery: (opts?: { text: string }) => Promise<unknown> }
): Promise<string> {
  await ctx.answerCallbackQuery({ text: "Consultando PDFs…" });
  try {
    const { pick3, pick4 } = await getPdfPageCounts();
    return (
      "📄 *Páginas de los PDF oficiales Florida Lottery*\n\n" +
      `• *Pick 3* (Fijo): *${pick3}* página${pick3 !== 1 ? "s" : ""}\n` +
      `• *Pick 4* (Corrido): *${pick4}* página${pick4 !== 1 ? "s" : ""}\n\n` +
      "_Fuente: files.floridalottery.com_"
    );
  } catch (e) {
    console.error("Pdf page count error:", e);
    return "No pude leer los PDFs. Prueba más tarde.";
  }
}

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  let result: string;

  if (data === "generate") {
    result = processGenerateNumbers();
  } else if (data === "probability") {
    result = processProbability();
  } else if (data === "help") {
    result = "*❓ Ayuda*\n\n" + HELP_TEXT;
  } else if (data.startsWith("fl_p3_") || data.startsWith("fl_p4_")) {
    const match = data.match(/^fl_p(3|4)_(hoy|ayer|fecha|todo)_(e|m)$/);
    if (match) {
      const game = match[1] === "3" ? "Pick 3" : "Pick 4";
      const period: DrawPeriod = match[3] === "e" ? "evening" : "midday";
      const periodLabel = period === "evening" ? "Noche (E)" : "Mediodía (M)";
      if (match[2] === "fecha") {
        await ctx.answerCallbackQuery();
        const userId = ctx.from?.id;
        if (userId) {
          waitingCustomDate.set(userId, {
            game: match[1] === "3" ? "pick3" : "pick4",
            period,
          });
          result =
            `📅 *Fecha custom — ${game} ${periodLabel}*\n\n` +
            `Formato: \`MM/DD/AA\` (ej: 02/25/26)\n\n` +
            `Solo la fecha. /cancel para cancelar.`;
        } else {
          result = "No se pudo iniciar. Intenta de nuevo.";
        }
      } else if (match[2] === "todo") {
        result = await handleFloridaTodo(ctx, game, period);
      } else {
        const dateFilter = match[2] === "hoy" ? "today" : "yesterday";
        const title =
          match[2] === "hoy"
            ? `Hoy ${periodLabel} — ${game}`
            : `Ayer ${periodLabel} — ${game}`;
        result = await handleFloridaDate(ctx, data, dateFilter, game, period, title);
      }
    } else {
      result = "Opción no reconocida. Usa /start para ver el menú.";
    }
  } else if (data === "fl_pdf_pages") {
    result = await handlePdfPages(ctx);
  } else {
    result = "Opción no reconocida. Usa /start para ver el menú.";
  }

  const isFloridaAsync =
    (data.startsWith("fl_p3_") || data.startsWith("fl_p4_")) &&
    !data.includes("fecha");
  const isFloridaFecha =
    data.includes("fl_p3_fecha_") || data.includes("fl_p4_fecha_");
  const isFloridaPdfPages = data === "fl_pdf_pages";

  try {
    if (!isFloridaAsync && !isFloridaFecha && !isFloridaPdfPages)
      await ctx.answerCallbackQuery();
    await ctx.editMessageText(result, {
      parse_mode: "Markdown",
      reply_markup: buildMainKeyboard(),
    });
  } catch (err) {
    await ctx.answerCallbackQuery({ text: "Listo ✓" }).catch(() => {});
    const msg = (err as Error).message ?? "";
    if (!msg.includes("message is not modified")) {
      console.error("Error en callback_query:", err);
    }
  }
});

bot.command("cancel", async (ctx) => {
  const userId = ctx.from?.id;
  if (userId && waitingCustomDate.has(userId)) {
    waitingCustomDate.delete(userId);
    await ctx.reply("Cancelado. Usa /start para ver el menú.", {
      reply_markup: buildMainKeyboard(),
    });
  } else {
    await ctx.reply("No hay nada que cancelar.");
  }
});

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id;
  const state = userId ? waitingCustomDate.get(userId) : undefined;
  if (!state) return;

  const text = ctx.message.text.trim();
  const date = parseUserDate(text);
  waitingCustomDate.delete(userId!);

  if (!date) {
    await ctx.reply(
      "❌ Fecha no válida. Usa formato MM/DD/AA (ej: 02/25/26). Escribe /start y elige de nuevo.",
      { reply_markup: buildMainKeyboard() }
    );
    return;
  }

  const gameName = state.game === "pick3" ? "Pick 3" : "Pick 4";
  const periodLabel = state.period === "evening" ? "Noche (E)" : "Mediodía (M)";
  const titleOverride = `Resultados del ${formatDateForLabel(date)} ${periodLabel} — ${gameName}`;
  try {
    const fetchResults = state.game === "pick3" ? fetchPick3Results : fetchPick4Results;
    const gameResults = await fetchResults(date);
    const filtered = {
      ...gameResults,
      draws: gameResults.draws.filter((d) => d.period === state.period),
    };
    const result = formatResultsForBot(filtered, titleOverride);
    await ctx.reply(result, {
      parse_mode: "Markdown",
      reply_markup: buildMainKeyboard(),
    });
  } catch (e) {
    console.error("Florida custom date fetch error:", e);
    await ctx.reply(
      `No pude cargar los resultados de ${gameName} para esa fecha. Prueba otra fecha o [consulta en Florida Lottery](https://floridalottery.com/games/draw-games/${state.game === "pick3" ? "pick-3" : "pick-4"}).`,
      { parse_mode: "Markdown", reply_markup: buildMainKeyboard() }
    );
  }
});

async function main(): Promise<void> {
  if (!BOT_TOKEN) {
    console.error("Configura TELEGRAM_BOT_TOKEN en el entorno.");
    console.error("Ejemplo: export TELEGRAM_BOT_TOKEN='tu-token'");
    process.exit(1);
  }

  // En Render la plataforma define PORT; sin WEBHOOK_URL no abrimos puerto y el deploy falla
  if (process.env.PORT && !WEBHOOK_URL) {
    console.error(
      "En este entorno (ej. Render) debes definir WEBHOOK_URL con la URL pública del servicio."
    );
    console.error("Ejemplo: WEBHOOK_URL=https://tu-app.onrender.com");
    process.exit(1);
  }

  // Menú de comandos que aparece al escribir "/" en Telegram
  await bot.api.setMyCommands([
    { command: "start", description: "Iniciar y ver opciones" },
    { command: "help", description: "Ver ayuda del bot" },
    { command: "cancel", description: "Cancelar y volver al menú" },
  ]);

  if (WEBHOOK_URL) {
    // Modo webhook: para Render u otro hosting que recibe HTTP
    const webhookPath = "/webhook";
    const fullUrl = `${WEBHOOK_URL.replace(/\/$/, "")}${webhookPath}`;
    await bot.api.setWebhook(fullUrl);
    console.log("Webhook registrado:", fullUrl);

    const handleUpdate = webhookCallback(bot, "http");
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
        return;
      }
      if (req.method === "POST" && req.url === webhookPath) {
        await handleUpdate(req, res);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
  } else {
    // Modo long polling: para desarrollo local
    console.log("Bot en marcha (long polling)...");
    await bot.start();
  }
}

main().catch(console.error);
