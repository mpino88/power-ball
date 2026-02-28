/**
 * Bot de Telegram: Florida Lottery Pick 3 y Pick 4 — resultados desde los PDF oficiales.
 * Fuentes: p3.pdf y p4.pdf. Menú: Hoy, Ayer, Esta Semana, Fecha específica (☀️ Mediodía / 🌙 Noche).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Bot, InlineKeyboard } from "grammy";
import type { Update } from "grammy/types";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";
const FLORIDA_TZ = "America/New_York";

const HELP_TEXT =
  "🏝 *Florida Lottery — Fijo y Corrido*\n\n" +
  "☀️ *Mediodía (M)* · 🌙 *Noche (E)*\n\n" +
  "Elige *Fijo* (P3), *Corrido* (P4) o *Ambos*; luego Hoy, Ayer, Esta semana o una fecha.";

type GameMenu = "fijo" | "corrido" | "ambos";

function buildMainKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🎯 Fijo (P3)", "menu_fijo")
    .text("🎲 Corrido (P4)", "menu_corrido")
    .row()
    .text("☀️🌙 Ambos (Fijo + Corrido)", "menu_ambos")
    .row()
    .text("📊 Estadísticas (grupos)", "menu_estadisticas")
    .row()
    .text("❓ Ayuda", "help");
}

function buildSubmenuKeyboard(game: GameMenu): InlineKeyboard {
  const prefix = game === "fijo" ? "fijo" : game === "corrido" ? "corrido" : "ambos";
  return new InlineKeyboard()
    .text("☀️🌙 Hoy", `${prefix}_hoy`)
    .text("☀️🌙 Ayer", `${prefix}_ayer`)
    .row()
    .text("📆 Esta semana", `${prefix}_semana`)
    .row()
    .text("📅 Escoger fecha", `${prefix}_fecha`)
    .row()
    .text("◀️ Volver", "volver");
}

/** Días de diferencia por defecto para marcar Hot: (Máx.hist - Máx.actual) ≤ este valor. */
let hotThresholdDays = 5;

function buildEstadisticasKeyboard(threshold: number = hotThresholdDays): InlineKeyboard {
  return new InlineKeyboard()
    .text("📊 Ver estadísticas", "stats_grupos")
    .text("📈 Est. individuales", "stats_individual")
    .row()
    .text(`🔢 Días diferencia: ${threshold}`, "stats_set_days")
    .row()
    .text("◀️ Volver", "volver");
}

function buildDiasDiferenciaKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("1", "stats_days_1")
    .text("3", "stats_days_3")
    .text("5", "stats_days_5")
    .text("7", "stats_days_7")
    .text("10", "stats_days_10")
    .row()
    .text("◀️ Volver", "volver");
}

const bot = new Bot(BOT_TOKEN);

bot.command("start", async (ctx) => {
  await ctx.reply(
    "👋 Resultados *Fijo* (P3) y *Corrido* (P4) de Florida Lottery.\n\nElige juego y luego el período:",
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

/** Usuario esperando escribir fecha → juego elegido (fijo, corrido o ambos). */
const waitingCustomDateGame = new Map<number, GameMenu>();

/** Usuario en Estadísticas individuales: puede escribir 00-99 para consultar. */
const waitingIndividualNumber = new Set<number>();

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  let result: string;
  let keyboard: InlineKeyboard = buildMainKeyboard();
  const asyncData =
    /^(fijo|corrido|ambos)_(hoy|ayer|semana)$/.test(data) || data === "stats_grupos" || data === "stats_individual";

  if (data === "help") {
    result = "*❓ Ayuda*\n\n" + HELP_TEXT;
  } else if (data === "menu_fijo") {
    await ctx.answerCallbackQuery();
    result = "🎯 *Fijo* (P3)\n\nElige período (☀️ Mediodía y 🌙 Noche):";
    keyboard = buildSubmenuKeyboard("fijo");
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  } else if (data === "menu_corrido") {
    await ctx.answerCallbackQuery();
    result = "🎲 *Corrido* (P4)\n\nElige período (☀️ Mediodía y 🌙 Noche):";
    keyboard = buildSubmenuKeyboard("corrido");
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  } else if (data === "menu_ambos") {
    await ctx.answerCallbackQuery();
    result = "☀️🌙 *Ambos* — Fijo y Corrido\n\nElige período:";
    keyboard = buildSubmenuKeyboard("ambos");
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  } else if (data === "menu_estadisticas") {
    await ctx.answerCallbackQuery();
    result = "📊 *Estadísticas por grupos* (Fijo P3)\n\nUsa los 2 últimos dígitos de cada sorteo (M y E). Grupos: terminales (0-9), iniciales (0-9), dobles.\n\n🔥 Hot = (Máx.hist − Máx.actual) ≤ Días diferencia.";
    keyboard = buildEstadisticasKeyboard();
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  } else if (data === "volver") {
    await ctx.answerCallbackQuery();
    result = "👋 Elige juego y luego el período:";
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  } else if (data === "stats_set_days") {
    await ctx.answerCallbackQuery();
    result = `🔢 *Días de diferencia* (valor actual: ${hotThresholdDays})\n\nSi (Máx.hist − Máx.actual) ≤ N, el grupo se marca 🔥 Hot. Elige N:`;
    keyboard = buildDiasDiferenciaKeyboard();
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  } else if (/^stats_days_\d+$/.test(data)) {
    const n = parseInt(data.replace("stats_days_", ""), 10);
    if (n >= 1 && n <= 30) hotThresholdDays = n;
    await ctx.answerCallbackQuery({ text: `Días diferencia = ${hotThresholdDays}` });
    result = "📊 *Estadísticas por grupos* (Fijo P3)\n\nUsa los 2 últimos dígitos de cada sorteo (M y E). Grupos: terminales (0-9), iniciales (0-9), dobles.\n\n🔥 Hot = (Máx.hist − Máx.actual) ≤ Días diferencia.";
    keyboard = buildEstadisticasKeyboard();
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  } else if (data === "stats_individual") {
    await ctx.answerCallbackQuery({ text: "Calculando…" });
    const userId = ctx.from?.id;
    try {
      const map3 = await getP3Map();
      result = buildIndividualTop10Message(map3, hotThresholdDays);
      if (userId) waitingIndividualNumber.add(userId);
      keyboard = buildMainKeyboard();
    } catch (e) {
      console.error("Individual stats error:", e);
      result = "No pude cargar el historial P3. Prueba más tarde.";
    }
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!msg.includes("message is not modified")) console.error("Error en callback_query:", err);
    }
    return;
  } else if (data === "stats_grupos") {
    await ctx.answerCallbackQuery({ text: "Calculando estadísticas…" });
    try {
      const map3 = await getP3Map();
      result = buildGroupStatsMessage(map3, hotThresholdDays);
      keyboard = buildMainKeyboard();
    } catch (e) {
      console.error("Group stats error:", e);
      result = "No pude cargar el historial P3. Prueba más tarde.";
    }
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!msg.includes("message is not modified")) console.error("Error en callback_query:", err);
    }
    return;
  } else if (data === "fijo_fecha" || data === "corrido_fecha" || data === "ambos_fecha") {
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
    keyboard = buildMainKeyboard();
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  const match = data.match(/^(fijo|corrido|ambos)_(hoy|ayer|semana)$/);
  if (match) {
    const [, game, scope] = match as [string, GameMenu, "hoy" | "ayer" | "semana"];
    const label = game === "fijo" ? "Fijo" : game === "corrido" ? "Corrido" : "Fijo y Corrido";
    await ctx.answerCallbackQuery({ text: `Cargando ${label}…` });
    try {
      const [map3, map4] = await Promise.all([getP3Map(), getP4Map()]);
      if (scope === "hoy") {
        const key = getTodayFloridaMMDDYY();
        const d3 = map3[key] ?? {};
        const d4 = map4[key] ?? {};
        result = buildResultOneDay(key, d3, d4, game, "Hoy");
      } else if (scope === "ayer") {
        const key = getYesterdayFloridaMMDDYY();
        const d3 = map3[key] ?? {};
        const d4 = map4[key] ?? {};
        result = buildResultOneDay(key, d3, d4, game, "Ayer");
      } else {
        const dates = getThisWeekFloridaMMDDYY();
        result = buildResultWeek(map3, map4, dates, game);
      }
      keyboard = buildMainKeyboard();
    } catch (e) {
      console.error("PDF map error:", e);
      result = "No pude cargar los PDF. Prueba más tarde.";
    }
  } else {
    result = "Opción no reconocida. Usa /start para ver el menú.";
  }

  try {
    if (!asyncData) await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch (err) {
    if (!asyncData) await ctx.answerCallbackQuery({ text: "Listo ✓" }).catch(() => {});
    const msg = (err as Error).message ?? "";
    if (!msg.includes("message is not modified")) console.error("Error en callback_query:", err);
  }
});

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
    `☀️🌙 *${title}* ${key}\n\n*Fijo*\n` + formatDrawsForMessage(key, d3) +
    "\n\n*Corrido*\n" + formatDrawsForMessage(key, d4)
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

bot.command("cancel", async (ctx) => {
  const userId = ctx.from?.id;
  if (userId) {
    waitingCustomDateGame.delete(userId);
    waitingIndividualNumber.delete(userId);
  }
  await ctx.reply("Cancelado.", { reply_markup: buildMainKeyboard() });
});

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id;
  const text = ctx.message.text.trim();

  if (userId && waitingIndividualNumber.has(userId)) {
    const num = parseIndividualNumber(text);
    if (num === null) {
      await ctx.reply("❌ Escribe un número entre 00 y 99 (ej: 42). /cancel para volver.");
      return;
    }
    try {
      const map3 = await getP3Map();
      const stats = computeIndividualStats(map3);
      const s = stats[num]!;
      const diff = s.currentGapDays !== null ? s.maxGapDays - s.currentGapDays : null;
      const hotStr = diff !== null && diff <= hotThresholdDays ? " 🔥 Hot" : "";
      const curStr = s.currentGapDays !== null ? String(s.currentGapDays) : "—";
      const msg =
        `📈 *Número ${String(num).padStart(2, "0")}*\n\n` +
        `Máx. histórico: ${s.maxGapDays} días\nMáx. actual: ${curStr}${hotStr}`;
      await ctx.reply(msg, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Individual stats error:", e);
      await ctx.reply("No pude cargar el historial. Prueba más tarde.");
    }
    return;
  }

  const game = userId ? waitingCustomDateGame.get(userId) : undefined;
  if (!userId || game === undefined) return;
  waitingCustomDateGame.delete(userId);
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
    const msg = buildResultOneDay(key, d3, d4, game, "Fecha");
    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: buildMainKeyboard() });
  } catch (e) {
    console.error("PDF map error:", e);
    await ctx.reply("No pude cargar los PDF. Prueba más tarde.", {
      reply_markup: buildMainKeyboard(),
    });
  }
});

// --- Estadísticas por grupos (P3: dos últimos dígitos) ---

/** Convierte MM/DD/YY a Date (año 20xx si yy < 50, sino 19xx). */
function mmddyyToDate(key: string): Date | null {
  const m = key.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  const dd = parseInt(m[2], 10);
  let yy = parseInt(m[3], 10);
  yy = yy >= 50 ? 1900 + yy : 2000 + yy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(yy, mm - 1, dd);
  if (d.getDate() !== dd || d.getMonth() !== mm - 1) return null;
  return d;
}

/** Ordena claves MM/DD/YY de más antiguo a más reciente. */
function sortDateKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const da = mmddyyToDate(a)?.getTime() ?? 0;
    const db = mmddyyToDate(b)?.getTime() ?? 0;
    return da - db;
  });
}

/** De un sorteo P3 [x,y,z] devuelve el número de 2 cifras yz (0-99). */
function twoDigitFromP3(draw: number[]): number {
  if (draw.length < 3) return 0;
  return draw[1]! * 10 + draw[2]!;
}

/** Números dobles: 00, 11, 22, ..., 99. */
const DOUBLES_SET = new Set([0, 11, 22, 33, 44, 55, 66, 77, 88, 99]);

interface GroupGap {
  maxGapDays: number;
  currentGapDays: number | null;
}

/**
 * Calcula Máx. histórico y Máx. actual por grupo con contadores (en días naturales):
 * - Si el grupo aparece hoy: contador → 0 y, si contador > máx histórico, actualizar máx histórico.
 * - Si el grupo no aparece hoy: contador += días transcurridos desde la fecha anterior.
 * Al final, Máx. actual = valor actual del contador (o — si nunca apareció).
 */
function computeGroupStats(map: DateDrawsMap): {
  terminales: GroupGap[];
  iniciales: GroupGap[];
  dobles: GroupGap;
} {
  const sortedDates = sortDateKeys(Object.keys(map));
  const emptyGap = (): GroupGap[] => Array.from({ length: 10 }, () => ({ maxGapDays: 0, currentGapDays: null }));
  if (sortedDates.length === 0) {
    return { terminales: emptyGap(), iniciales: emptyGap(), dobles: { maxGapDays: 0, currentGapDays: null } };
  }

  const dayDiff = (aStr: string, bStr: string): number => {
    const da = mmddyyToDate(aStr)?.getTime();
    const db = mmddyyToDate(bStr)?.getTime();
    if (da == null || db == null) return 0;
    return Math.round((db - da) / 864e5);
  };

  type Track = { counter: number; maxHistorical: number; everAppeared: boolean };
  const initTrack = (): Track => ({ counter: 0, maxHistorical: 0, everAppeared: false });
  const terminales = Array.from({ length: 10 }, () => initTrack());
  const iniciales = Array.from({ length: 10 }, () => initTrack());
  const doblesTrack = initTrack();

  let prevDateStr: string | null = null;

  for (const dateStr of sortedDates) {
    const draws = map[dateStr];
    const groupsThisDay = new Set<string>();
    for (const draw of [draws?.m, draws?.e]) {
      if (!draw || draw.length < 3) continue;
      const n = twoDigitFromP3(draw);
      groupsThisDay.add(`T${n % 10}`);
      groupsThisDay.add(`I${Math.floor(n / 10)}`);
      if (DOUBLES_SET.has(n)) groupsThisDay.add("D");
    }

    const daysSincePrev = prevDateStr !== null ? dayDiff(prevDateStr, dateStr) : 0;

    const tick = (t: Track, appeared: boolean) => {
      if (appeared) {
        if (t.counter > t.maxHistorical) t.maxHistorical = t.counter;
        t.counter = 0;
        t.everAppeared = true;
      } else {
        t.counter += daysSincePrev;
      }
    };

    for (let k = 0; k < 10; k++) tick(terminales[k]!, groupsThisDay.has(`T${k}`));
    for (let k = 0; k < 10; k++) tick(iniciales[k]!, groupsThisDay.has(`I${k}`));
    tick(doblesTrack, groupsThisDay.has("D"));

    prevDateStr = dateStr;
  }

  const toGap = (t: Track): GroupGap => ({
    maxGapDays: t.maxHistorical,
    currentGapDays: t.everAppeared ? t.counter : null,
  });

  return {
    terminales: terminales.map(toGap),
    iniciales: iniciales.map(toGap),
    dobles: toGap(doblesTrack),
  };
}

/** Estadísticas por número individual 0-99 (mismo criterio: contador + máx histórico). */
function computeIndividualStats(map: DateDrawsMap): (GroupGap)[] {
  const sortedDates = sortDateKeys(Object.keys(map));
  const result: (GroupGap)[] = Array.from({ length: 100 }, () => ({ maxGapDays: 0, currentGapDays: null }));
  if (sortedDates.length === 0) return result;

  const dayDiff = (aStr: string, bStr: string): number => {
    const da = mmddyyToDate(aStr)?.getTime();
    const db = mmddyyToDate(bStr)?.getTime();
    if (da == null || db == null) return 0;
    return Math.round((db - da) / 864e5);
  };

  type Track = { counter: number; maxHistorical: number; everAppeared: boolean };
  const tracks: Track[] = Array.from({ length: 100 }, () => ({ counter: 0, maxHistorical: 0, everAppeared: false }));
  let prevDateStr: string | null = null;

  for (const dateStr of sortedDates) {
    const draws = map[dateStr];
    const numbersThisDay = new Set<number>();
    for (const draw of [draws?.m, draws?.e]) {
      if (!draw || draw.length < 3) continue;
      numbersThisDay.add(twoDigitFromP3(draw));
    }
    const daysSincePrev = prevDateStr !== null ? dayDiff(prevDateStr, dateStr) : 0;

    for (let n = 0; n < 100; n++) {
      const t = tracks[n]!;
      if (numbersThisDay.has(n)) {
        if (t.counter > t.maxHistorical) t.maxHistorical = t.counter;
        t.counter = 0;
        t.everAppeared = true;
      } else {
        t.counter += daysSincePrev;
      }
    }
    prevDateStr = dateStr;
  }

  for (let n = 0; n < 100; n++) {
    const t = tracks[n]!;
    result[n] = {
      maxGapDays: t.maxHistorical,
      currentGapDays: t.everAppeared ? t.counter : null,
    };
  }
  return result;
}

/** Parsea texto a número 0-99 (acepta "0"-"99", "00"-"99"). */
function parseIndividualNumber(text: string): number | null {
  const t = text.trim();
  if (/^\d{1,2}$/.test(t)) {
    const n = parseInt(t, 10);
    if (n >= 0 && n <= 99) return n;
  }
  return null;
}

/** Top 10 más Hot: menor (Máx.hist − Máx.actual) entre los que han aparecido. */
function getTop10HottestIndividual(stats: (GroupGap)[]): { num: number; maxGapDays: number; currentGapDays: number }[] {
  const withCur: { num: number; maxGapDays: number; currentGapDays: number }[] = [];
  for (let n = 0; n < 100; n++) {
    const s = stats[n]!;
    if (s.currentGapDays !== null) withCur.push({ num: n, maxGapDays: s.maxGapDays, currentGapDays: s.currentGapDays });
  }
  withCur.sort((a, b) => a.maxGapDays - a.currentGapDays - (b.maxGapDays - b.currentGapDays));
  return withCur.slice(0, 10);
}

function buildIndividualTop10Message(map: DateDrawsMap, diasDiferencia: number): string {
  const stats = computeIndividualStats(map);
  const top10 = getTop10HottestIndividual(stats);
  const W_NUM = 6;
  const W_MAX = 10;
  const W_ACT = 10;
  const W_HOT = 8;
  const fmt = (num: number, maxH: number, cur: number) => {
    const diff = maxH - cur;
    const hotStr = diff <= diasDiferencia ? "🔥 Hot" : "";
    return (
      String(num).padStart(2, "0").padEnd(W_NUM) +
      String(maxH).padStart(W_MAX) +
      String(cur).padStart(W_ACT) +
      hotStr.padStart(W_HOT)
    );
  };
  const sep = "─".repeat(W_NUM + W_MAX + W_ACT + W_HOT);
  const header = "Número".padEnd(W_NUM) + "Máx.hist".padStart(W_MAX) + "Máx.actual".padStart(W_ACT) + "Hot".padStart(W_HOT);
  const lines: string[] = [
    `📈 *Top 10 más Hot* (números 00-99, 2 últimos dígitos P3)\n`,
    "```",
    header,
    sep,
    ...top10.map(({ num, maxGapDays, currentGapDays }) => fmt(num, maxGapDays, currentGapDays)),
    "```",
    "\nEscribe un número *00-99* para consultar uno específico. /cancel para volver.",
  ];
  return lines.join("\n");
}

function buildGroupStatsMessage(map: DateDrawsMap, diasDiferencia: number = 5): string {
  const stats = computeGroupStats(map);
  const W_NAME = 12;
  const W_MAX = 10;
  const W_ACT = 10;
  const W_HOT = 8;
  const isHot = (maxH: number, cur: number | null) =>
    cur !== null && maxH - cur <= diasDiferencia;
  const fmt = (name: string, maxH: number, cur: number | null) => {
    const curStr = cur !== null ? String(cur) : "—";
    const hotStr = isHot(maxH, cur) ? "🔥 Hot" : "";
    return (
      name.padEnd(W_NAME) +
      String(maxH).padStart(W_MAX) +
      curStr.padStart(W_ACT) +
      hotStr.padStart(W_HOT)
    );
  };
  const sep = "─".repeat(W_NAME + W_MAX + W_ACT + W_HOT);
  const header =
    "Grupo".padEnd(W_NAME) +
    "Máx.hist".padStart(W_MAX) +
    "Máx.actual".padStart(W_ACT) +
    "Hot".padStart(W_HOT);
  const lines: string[] = [
    `📊 *Estadísticas por grupos* (Fijo P3, 2 últimos dígitos) · Hot si (Máx.hist−Máx.actual) ≤ ${diasDiferencia}\n`,
    "```",
    header,
    sep,
  ];
  for (let k = 0; k < 10; k++) {
    const t = stats.terminales[k]!;
    lines.push(fmt(`Terminal ${k}`, t.maxGapDays, t.currentGapDays));
  }
  lines.push(sep);
  for (let k = 0; k < 10; k++) {
    const t = stats.iniciales[k]!;
    lines.push(fmt(`Inicial ${k}`, t.maxGapDays, t.currentGapDays));
  }
  lines.push(sep);
  lines.push(fmt("Dobles", stats.dobles.maxGapDays, stats.dobles.currentGapDays));
  lines.push("```");
  return lines.join("\n");
}

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

  await bot.init();

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
