/**
 * Bot de Telegram con menú de botones y procesamiento.
 * Ejemplo: generación de números tipo Power Ball y cálculos.
 * Soporta webhook (para Render u otro hosting gratis) y long polling (local).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Bot, InlineKeyboard, webhookCallback } from "grammy";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? ""; // ej: https://tu-bot.onrender.com

const HELP_TEXT =
  "🎱 *Generar números*\nSimula una combinación tipo Power Ball: 5 números (1-69) + Power Ball (1-26).\n\n" +
  "📊 *Calcular probabilidad*\nProbabilidad de acertar el jackpot (1 entre ~292 millones).\n\n" +
  "🔄 *Otra combinación*\nGenera una nueva combinación.\n\n" +
  "Usa los botones o escribe /start para ver el menú.";

function buildMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎱 Generar números", "generate")
    .text("📊 Calcular probabilidad", "probability")
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

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;

  let result: string;
  if (data === "generate") {
    result = processGenerateNumbers();
  } else if (data === "probability") {
    result = processProbability();
  } else if (data === "help") {
    result = "*❓ Ayuda*\n\n" + HELP_TEXT;
  } else {
    result = "Opción no reconocida. Usa /start para ver el menú.";
  }

  try {
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
