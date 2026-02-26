/**
 * Bot de Telegram con menú de botones y procesamiento.
 * Ejemplo: generación de números tipo Power Ball y cálculos.
 * Soporta webhook (para Render u otro hosting gratis) y long polling (local).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import type { DateFilter } from "./florida-lottery.js";
import {
  fetchPick3Results,
  fetchPick4Results,
  formatDateForLabel,
  formatResultsForBot,
} from "./florida-lottery.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? ""; // ej: https://tu-bot.onrender.com

const HELP_TEXT =
  "🎱 *Generar números*\nSimula una combinación tipo Power Ball: 5 números (1-69) + Power Ball (1-26).\n\n" +
  "📊 *Calcular probabilidad*\nProbabilidad de acertar el jackpot (1 entre ~292 millones).\n\n" +
  "🏝 *Pick 3 / Pick 4 Florida*\nResultados por *Hoy*, *Ayer* o *Fecha custom* (mediodía y noche).\n\n" +
  "🔄 *Otra combinación*\nGenera una nueva combinación.\n\n" +
  "Usa los botones o escribe /start para ver el menú.";

/** Usuarios esperando escribir una fecha (game = pick3 | pick4). */
const waitingCustomDate = new Map<number, "pick3" | "pick4">();

/** Convierte año 2 dígitos a 4 (25 → 2026, 99 → 1999). */
function fullYear(yy: number): number {
  if (yy >= 0 && yy <= 99) return yy >= 50 ? 1900 + yy : 2000 + yy;
  return yy;
}

/** Parsea fecha escrita por el usuario. Formatos: MM/DD/YY, MM/DD/YYYY, DD/MM/YYYY, YYYY-MM-DD. */
function parseUserDate(text: string): Date | null {
  const t = text.trim();
  const dash = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$|^(\d{4})\/(\d{1,2})\/(\d{1,2})$/;
  const mmddyy = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/; // MM/DD/YY
  let m = t.match(dash);
  if (m) {
    const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = t.match(mmddyy);
  if (m) {
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    const year = fullYear(parseInt(m[3], 10));
    const d = new Date(year, month - 1, day);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  m = t.match(slash);
  if (m) {
    if (m[4]) {
      const d = new Date(parseInt(m[4], 10), parseInt(m[5], 10) - 1, parseInt(m[6], 10));
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(parseInt(m[3], 10), parseInt(m[2], 10) - 1, parseInt(m[1], 10));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

function buildMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎱 Generar números", "generate")
    .text("📊 Calcular probabilidad", "probability")
    .row()
    .text("🏝 P3 Hoy", "fl_p3_hoy")
    .text("🏝 P3 Ayer", "fl_p3_ayer")
    .text("🏝 P3 Fecha", "fl_p3_fecha")
    .row()
    .text("🏝 P4 Hoy", "fl_p4_hoy")
    .text("🏝 P4 Ayer", "fl_p4_ayer")
    .text("🏝 P4 Fecha", "fl_p4_fecha")
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
  titleOverride?: string
): Promise<string> {
  await ctx.answerCallbackQuery({ text: `Consultando ${game}…` });
  try {
    const fetchResults = game === "Pick 3" ? fetchPick3Results : fetchPick4Results;
    const gameResults = await fetchResults(dateFilter);
    return formatResultsForBot(gameResults, titleOverride);
  } catch (e) {
    console.error(`${game} fetch error:`, e);
    return `No pude cargar los resultados de ${game}. Prueba más tarde o revisa en:\n[${game} – Florida Lottery](https://floridalottery.com/games/draw-games/${game === "Pick 3" ? "pick-3" : "pick-4"})`;
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
  } else if (data === "fl_p3_hoy") {
    result = await handleFloridaDate(ctx, data, "today", "Pick 3", "Resultados de hoy — Pick 3");
  } else if (data === "fl_p3_ayer") {
    result = await handleFloridaDate(ctx, data, "yesterday", "Pick 3", "Resultados de ayer — Pick 3");
  } else if (data === "fl_p4_hoy") {
    result = await handleFloridaDate(ctx, data, "today", "Pick 4", "Resultados de hoy — Pick 4");
  } else if (data === "fl_p4_ayer") {
    result = await handleFloridaDate(ctx, data, "yesterday", "Pick 4", "Resultados de ayer — Pick 4");
  } else if (data === "fl_p3_fecha" || data === "fl_p4_fecha") {
    await ctx.answerCallbackQuery();
    const game = data === "fl_p3_fecha" ? "pick3" : "pick4";
    const userId = ctx.from?.id;
    if (userId) {
      waitingCustomDate.set(userId, game);
      result =
        `📅 *Fecha custom — ${game === "pick3" ? "Pick 3" : "Pick 4"}*\n\n` +
        `Formato del documento: \`MM/DD/AA\`\n\n` +
        `Introduce la fecha, por ejemplo:\n` +
        `• \`02/25/26\` (25 feb 2026)\n` +
        `• \`02/25/2026\` o \`2026-02-25\`\n\n` +
        `Solo la fecha, sin texto. /cancel para cancelar.`;
    } else {
      result = "No se pudo iniciar. Intenta de nuevo.";
    }
  } else {
    result = "Opción no reconocida. Usa /start para ver el menú.";
  }

  const isFloridaAsync = [
    "fl_p3_hoy", "fl_p3_ayer", "fl_p4_hoy", "fl_p4_ayer",
  ].includes(data);
  const isFloridaFecha = data === "fl_p3_fecha" || data === "fl_p4_fecha";

  try {
    if (!isFloridaAsync && !isFloridaFecha) await ctx.answerCallbackQuery();
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
  const game = userId ? waitingCustomDate.get(userId) : undefined;
  if (!game) return;

  const text = ctx.message.text.trim();
  const date = parseUserDate(text);
  waitingCustomDate.delete(userId!);

  if (!date) {
    await ctx.reply(
      "❌ Fecha no válida. Usa formato MM/DD/AA (ej: 02/25/26). Escribe /start y elige de nuevo «P3 Fecha» o «P4 Fecha».",
      { reply_markup: buildMainKeyboard() }
    );
    return;
  }

  const gameName = game === "pick3" ? "Pick 3" : "Pick 4";
  const titleOverride = `Resultados del ${formatDateForLabel(date)} — ${gameName}`;
  try {
    const fetchResults = game === "pick3" ? fetchPick3Results : fetchPick4Results;
    const gameResults = await fetchResults(date);
    const result = formatResultsForBot(gameResults, titleOverride);
    await ctx.reply(result, {
      parse_mode: "Markdown",
      reply_markup: buildMainKeyboard(),
    });
  } catch (e) {
    console.error("Florida custom date fetch error:", e);
    await ctx.reply(
      `No pude cargar los resultados de ${gameName} para esa fecha. La web solo tiene historial reciente. Prueba otra fecha o [consulta en Florida Lottery](https://floridalottery.com/games/draw-games/${game === "pick3" ? "pick-3" : "pick-4"}).`,
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
