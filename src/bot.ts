/**
 * Bot de Telegram: Florida Lottery Pick 3 y Pick 4 — resultados desde los PDF oficiales.
 * Fuentes: p3.pdf y p4.pdf. Menú: Hoy, Ayer, Esta Semana, Fecha específica (☀️ Mediodía / 🌙 Noche).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Bot, InlineKeyboard, webhookCallback } from "grammy";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";
const FLORIDA_TZ = "America/New_York";

const HELP_TEXT =
  "🏝 *Florida Lottery — Fijo y Corrido*\n\n" +
  "☀️ *Mediodía (M)* · 🌙 *Noche (E)*\n\n" +
  "*Fijo* (P3) y *Corrido* (P4).\n" +
  "*Hoy / Ayer / Esta Semana / Fecha específica:* resultados de ambos.\n\n" +
  "[Fijo P3](https://files.floridalottery.com/exptkt/p3.pdf) · [Corrido P4](https://files.floridalottery.com/exptkt/p4.pdf)";

function buildMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("☀️🌙 Hoy", "p3_hoy")
    .text("☀️🌙 Ayer", "p3_ayer")
    .row()
    .text("☀️🌙 Esta Semana", "p3_semana")
    .row()
    .text("📅 Fecha específica", "p3_fecha")
    .row()
    .text("❓ Ayuda", "help");
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

const waitingCustomDate = new Set<number>();

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  let result: string;
  const isAsync =
    data === "p3_hoy" || data === "p3_ayer" || data === "p3_semana" || data === "p3_fecha";

  if (data === "help") {
    result = "*❓ Ayuda*\n\n" + HELP_TEXT;
  } else if (data === "p3_hoy") {
    await ctx.answerCallbackQuery({ text: "Cargando Hoy…" });
    try {
      const [map3, map4] = await Promise.all([getP3Map(), getP4Map()]);
      const key = getTodayFloridaMMDDYY();
      const d3 = map3[key] ?? {};
      const d4 = map4[key] ?? {};
      result =
        "☀️🌙 *Hoy* " + key + "\n\n*Fijo*\n" + formatDrawsForMessage(key, d3) +
        "\n\n*Corrido*\n" + formatDrawsForMessage(key, d4) +
        "\n\n[Fijo P3](https://files.floridalottery.com/exptkt/p3.pdf) · [Corrido P4](https://files.floridalottery.com/exptkt/p4.pdf)";
    } catch (e) {
      console.error("PDF map error:", e);
      result = "No pude cargar los PDF. Prueba más tarde.";
    }
  } else if (data === "p3_ayer") {
    await ctx.answerCallbackQuery({ text: "Cargando Ayer…" });
    try {
      const [map3, map4] = await Promise.all([getP3Map(), getP4Map()]);
      const key = getYesterdayFloridaMMDDYY();
      const d3 = map3[key] ?? {};
      const d4 = map4[key] ?? {};
      result =
        "☀️🌙 *Ayer* " + key + "\n\n*Fijo*\n" + formatDrawsForMessage(key, d3) +
        "\n\n*Corrido*\n" + formatDrawsForMessage(key, d4) +
        "\n\n[Fijo P3](https://files.floridalottery.com/exptkt/p3.pdf) · [Corrido P4](https://files.floridalottery.com/exptkt/p4.pdf)";
    } catch (e) {
      console.error("PDF map error:", e);
      result = "No pude cargar los PDF. Prueba más tarde.";
    }
  } else if (data === "p3_semana") {
    await ctx.answerCallbackQuery({ text: "Cargando Esta Semana…" });
    try {
      const [map3, map4] = await Promise.all([getP3Map(), getP4Map()]);
      const dates = getThisWeekFloridaMMDDYY();
      let body = "☀️🌙 *Esta Semana*\n\n";
      for (const key of dates) {
        const d3 = map3[key];
        const d4 = map4[key];
        if ((d3 && (d3.m || d3.e)) || (d4 && (d4.m || d4.e))) {
          if (d3 && (d3.m || d3.e)) body += "*Fijo* " + formatDrawsForMessage(key, d3) + "\n\n";
          if (d4 && (d4.m || d4.e)) body += "*Corrido* " + formatDrawsForMessage(key, d4) + "\n\n";
        }
      }
      result = (body.trim() || "_Sin datos para estos días._") + "\n\n[Fijo P3](https://files.floridalottery.com/exptkt/p3.pdf) · [Corrido P4](https://files.floridalottery.com/exptkt/p4.pdf)";
    } catch (e) {
      console.error("PDF map error:", e);
      result = "No pude cargar los PDF. Prueba más tarde.";
    }
  } else if (data === "p3_fecha") {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (userId) {
      waitingCustomDate.add(userId);
      result =
        "📅 *Fecha específica*\n\nEscribe la fecha en formato *MM/DD/AA* (ej: 02/25/26).\n\nUsa /cancel para cancelar.";
    } else {
      result = "No se pudo iniciar.";
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

bot.command("cancel", async (ctx) => {
  const userId = ctx.from?.id;
  if (userId) waitingCustomDate.delete(userId);
  await ctx.reply("Cancelado.", { reply_markup: buildMainKeyboard() });
});

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id;
  if (!userId || !waitingCustomDate.has(userId)) return;
  waitingCustomDate.delete(userId);
  const text = ctx.message.text.trim();
  const key = parseUserDateToMMDDYY(text);
  if (!key) {
    await ctx.reply("❌ Fecha no válida. Usa MM/DD/AA (ej: 02/25/26).", {
      reply_markup: buildMainKeyboard(),
    });
    return;
  }
  try {
    const [map3, map4] = await Promise.all([getP3Map(), getP4Map()]);
    const d3 = map3[key] ?? {};
    const d4 = map4[key] ?? {};
    const msg =
      "📅 *" + key + "*\n\n*Fijo*\n" + formatDrawsForMessage(key, d3) +
      "\n\n*Corrido*\n" + formatDrawsForMessage(key, d4) +
      "\n\n[Fijo P3](https://files.floridalottery.com/exptkt/p3.pdf) · [Corrido P4](https://files.floridalottery.com/exptkt/p4.pdf)";
    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: buildMainKeyboard() });
  } catch (e) {
    console.error("PDF map error:", e);
    await ctx.reply("No pude cargar los PDF. Prueba más tarde.", {
      reply_markup: buildMainKeyboard(),
    });
  }
});

/** PDF oficial Florida Lottery — Winning Numbers History (E: Evening, M: Midday). */
const P3_PDF_URL = "https://files.floridalottery.com/exptkt/p3.pdf";
const P4_PDF_URL = "https://files.floridalottery.com/exptkt/p4.pdf";

/** Tres números del sorteo (Pick 3). */
export type Pick3Numbers = [number, number, number];

/** Por fecha: sorteos de mediodía (m) y/o noche (e). */
export type DateDraws = {
  m?: Pick3Numbers;
  e?: Pick3Numbers;
};

/** Mapa: fecha (MM/DD/YY) → { m?: [n,n,n], e?: [n,n,n] }. */
export type DateDrawsMap = Record<string, DateDraws>;

/** Pick 4: cuatro números por sorteo. */
export type Pick4Numbers = [number, number, number, number];
export type DateDrawsP4 = { m?: Pick4Numbers; e?: Pick4Numbers };
export type DateDrawsMapP4 = Record<string, DateDrawsP4>;

/** Formatea un bloque de sorteos (m/e) para una fecha; sirve para P3 y P4. */
function formatDrawsForMessage(dateLabel: string, draws: { m?: number[]; e?: number[] }): string {
  let s = `*${dateLabel}*\n`;
  if (draws.m?.length) s += `☀️ Mediodía (M): \`${draws.m.join("-")}\`\n`;
  if (draws.e?.length) s += `🌙 Noche (E): \`${draws.e.join("-")}\`\n`;
  if (!draws.m?.length && !draws.e?.length) s += "_Sin datos_\n";
  return s.trim();
}

/** Fechas en Florida (MM/DD/YY). */
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
/** Últimos 7 días (hoy + 6 anteriores) en MM/DD/YY. */
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

/** Parsea entrada de usuario a MM/DD/YY para buscar en el mapa. Acepta MM/DD/YY, DD/MM/YY, YYYY-MM-DD. */
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

/**
 * Parsea una línea con formato: fecha tipo(E|M) # - # - #
 * Acepta espacios y guiones entre los números. Ignora "FB N" si aparece.
 */
export function parseP3Line(line: string): { date: string; type: "e" | "m"; numbers: Pick3Numbers } | null {
  const trimmed = line.trim();
  const match = trimmed.match(
    /^(\d{2}\/\d{2}\/\d{2})\s+([EM])\s+(\d)\s*[\s\-]*\s*(\d)\s*[\s\-]*\s*(\d)(?:\s+FB\s+\d)?/i
  );
  if (!match) return null;
  const [, date, type, n1, n2, n3] = match;
  const period = type.toUpperCase() === "E" ? "e" : "m";
  return {
    date,
    type: period,
    numbers: [Number(n1), Number(n2), Number(n3)],
  };
}

/**
 * A partir de un listado de líneas de texto, construye el mapa fecha → { e?, m? }.
 */
export function buildDateDrawsMap(lines: string[]): DateDrawsMap {
  const map: DateDrawsMap = {};
  for (const line of lines) {
    const parsed = parseP3Line(line);
    if (!parsed) continue;
    if (!map[parsed.date]) map[parsed.date] = {};
    map[parsed.date][parsed.type] = parsed.numbers;
  }
  return map;
}

/**
 * Patrones que identificamos en el PDF (Florida Lottery PICK 3):
 *   MM/DD/YY E #-#-# FB #   (Evening)
 *   MM/DD/YY M #-#-# FB #   (Midday)
 * Los tres números pueden ir con guiones o espacios (#-#-# o # # #). "FB N" es opcional.
 */
const P3_RECORD_REGEX =
  /(\d{2}\/\d{2}\/\d{2})\s*([EM])\s*(\d)[\s\-]*(\d)[\s\-]*(\d)(?:\s+FB\s*(\d))?/gi;

/**
 * Parsea el texto extraído del PDF buscando todos los registros que coincidan con
 * MM/DD/YY E #-#-# FB # o MM/DD/YY M #-#-# FB # (varias columnas o líneas concatenadas).
 */
export function parseP3FullText(text: string): DateDrawsMap {
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
    // m[6] sería el Fireball si se quiere guardar más adelante
  }
  return map;
}

/** Pick 4: MM/DD/YY E/M #-#-#-# FB # */
const P4_RECORD_REGEX =
  /(\d{2}\/\d{2}\/\d{2})\s*([EM])\s*(\d)[\s\-]*(\d)[\s\-]*(\d)[\s\-]*(\d)(?:\s+FB\s*(\d))?/gi;

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
    const numbers: Pick4Numbers = [Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
    if (!map[date]) map[date] = {};
    map[date][type] = numbers;
  }
  return map;
}

/** Convierte un buffer PDF a texto usando Mozilla PDF.js (pdfjs-dist). No usa pdf-parse. */
async function pdfToText(pdfBuffer: ArrayBuffer): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(pdfBuffer);
  const standardFontsDir = path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts");
  const standardFontDataUrl = pathToFileURL(standardFontsDir + path.sep).href;
  const doc = await pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    standardFontDataUrl,
  }).promise;
  const numPages = doc.numPages;
  const pageTexts: string[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    type Item = { str: string; transform?: number[] };
    const rawItems = content.items as Item[];
    // Ordenar por posición: arriba-abajo (y desc), izquierda-derecha (x asc) para columnas.
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

/** Obtiene el mapa Pick 3 (carga p3.pdf si hace falta). */
async function getP3Map(): Promise<DateDrawsMap> {
  if (cachedP3Map) return cachedP3Map;
  const res = await fetch(P3_PDF_URL, { headers: { "User-Agent": "FloridaLotteryBot/1.0" } });
  if (!res.ok) throw new Error(`P3 PDF ${res.status}`);
  const txt = await pdfToText(await res.arrayBuffer());
  cachedP3Map = parseP3FullText(txt);
  return cachedP3Map;
}

/** Obtiene el mapa Pick 4 (carga p4.pdf si hace falta). */
async function getP4Map(): Promise<DateDrawsMapP4> {
  if (cachedP4Map) return cachedP4Map;
  const res = await fetch(P4_PDF_URL, { headers: { "User-Agent": "FloridaLotteryBot/1.0" } });
  if (!res.ok) throw new Error(`P4 PDF ${res.status}`);
  const txt = await pdfToText(await res.arrayBuffer());
  cachedP4Map = parseP4FullText(txt);
  return cachedP4Map;
}

/**
 * Lee el PDF desde https://files.floridalottery.com/exptkt/p3.pdf, extrae el texto
 * e identifica los patrones MM/DD/YY E #-#-# FB # y MM/DD/YY M #-#-# FB # para construir
 * el mapa fecha → { e?, m? } con los tres números por sorteo.
 */
async function printP3PdfLines(): Promise<void> {
  try {
    const res = await fetch(P3_PDF_URL, {
      headers: { "User-Agent": "FloridaLotteryBot/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    const txt = await pdfToText(ab);
    const map = parseP3FullText(txt);
    console.log("--- PDF P3 → Mapa fecha → { e?, m? } (#-#-#) ---");
    console.log(JSON.stringify(map, null, 2));
    console.log("--- fin PDF P3 ---");
  } catch (e) {
    console.error("Error leyendo PDF P3:", e);
  }
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

  await bot.api.setMyCommands([
    { command: "start", description: "Iniciar y ver opciones" },
    { command: "help", description: "Ver ayuda" },
    { command: "cancel", description: "Cancelar y volver al menú" },
  ]);

  if (WEBHOOK_URL) {
    const webhookPath = "/webhook";
    const fullUrl = `${WEBHOOK_URL.replace(/\/$/, "")}${webhookPath}`;
    await bot.api.setWebhook(fullUrl);

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
    server.listen(PORT);
  } else {
    await bot.start();
  }
}

main().catch(console.error);
