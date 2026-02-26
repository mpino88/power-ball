/**
 * Bot de Telegram: resultados recientes de Florida Lottery (Pick 3 y Pick 4)
 * obtenidos por scraping de floridalottery.com/games/draw-games/pick-3 y pick-4.
 * Soporta webhook (Render) y long polling (local).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Bot, InlineKeyboard, webhookCallback } from "grammy";
import {
  fetchPick3RecentResults,
  fetchPick4RecentResults,
  formatResultsForBot,
} from "./florida-lottery.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";

const HELP_TEXT =
  "🏝 *Florida Lottery — Resultados recientes*\n\n" +
  "*Fijo (P3):* Pick 3.\n*Corridos (P4):* Pick 4.\n*Ambos:* Pick 3 y Pick 4.\n\n" +
  "Fuente: [floridalottery.com](https://floridalottery.com/games/draw-games/pick-3)";

function buildMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Fijo (P3)", "fl_p3")
    .text("Corridos (P4)", "fl_p4")
    .text("Ambos", "fl_ambos");
}

const bot = new Bot(BOT_TOKEN);

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 Resultados recientes de *Florida Lottery*.\n\nElige:",
    {
      parse_mode: "Markdown",
      reply_markup: buildMainKeyboard(),
    }
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(HELP_TEXT, {
    parse_mode: "Markdown",
    reply_markup: buildMainKeyboard(),
  });
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  let result: string;
  const isAsync = data === "fl_p3" || data === "fl_p4" || data === "fl_ambos";

  if (data === "fl_p3") {
    await ctx.answerCallbackQuery({ text: "Consultando Fijo (P3)…" });
    try {
      const gameResults = await fetchPick3RecentResults();
      result = formatResultsForBot(gameResults);
    } catch (e) {
      console.error("Pick 3 scrape error:", e);
      result =
        "No pude cargar Fijo (P3). Prueba más tarde.\n\n[Pick 3 — Florida Lottery](https://floridalottery.com/games/draw-games/pick-3)";
    }
  } else if (data === "fl_p4") {
    await ctx.answerCallbackQuery({ text: "Consultando Corridos (P4)…" });
    try {
      const gameResults = await fetchPick4RecentResults();
      result = formatResultsForBot(gameResults);
    } catch (e) {
      console.error("Pick 4 scrape error:", e);
      result =
        "No pude cargar Corridos (P4). Prueba más tarde.\n\n[Pick 4 — Florida Lottery](https://floridalottery.com/games/draw-games/pick-4)";
    }
  } else if (data === "fl_ambos") {
    await ctx.answerCallbackQuery({ text: "Consultando ambos…" });
    try {
      const [p3, p4] = await Promise.all([
        fetchPick3RecentResults(),
        fetchPick4RecentResults(),
      ]);
      const part3 = formatResultsForBot(p3);
      const part4 = formatResultsForBot(p4);
      result = part3 + "\n\n" + part4;
    } catch (e) {
      console.error("Ambos scrape error:", e);
      result =
        "No pude cargar los resultados. Prueba más tarde.\n\n[Florida Lottery](https://floridalottery.com/games/draw-games/pick-3)";
    }
  } else {
    result = "Opción no reconocida. Usa /start para ver el menú.";
  }

  const needsAnswer = !isAsync;
  try {
    if (needsAnswer) await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText(result, {
      parse_mode: "Markdown",
      reply_markup: buildMainKeyboard(),
    });
  } catch (err) {
    if (needsAnswer) await ctx.answerCallbackQuery({ text: "Listo ✓" }).catch(() => {});
    const msg = (err as Error).message ?? "";
    if (!msg.includes("message is not modified")) console.error("Error en callback_query:", err);
  }
});

async function main(): Promise<void> {
  if (!BOT_TOKEN) {
    console.error("Configura TELEGRAM_BOT_TOKEN en el entorno.");
    process.exit(1);
  }
  if (process.env.PORT && !WEBHOOK_URL) {
    console.error("En este entorno debes definir WEBHOOK_URL (ej: https://tu-app.onrender.com).");
    process.exit(1);
  }

  await bot.api.setMyCommands([
    { command: "start", description: "Iniciar y ver opciones" },
    { command: "help", description: "Ver ayuda" },
  ]);

  if (WEBHOOK_URL) {
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
    server.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
  } else {
    console.log("Bot en marcha (long polling)...");
    await bot.start();
  }
}

main().catch(console.error);
