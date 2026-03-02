/**
 * Handler único de callbacks de menús (help, volver, juego, estadísticas, período).
 * No incluye seguridad (admin_*) ni menús extra (menu_<id>); el bot los despacha por separado.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { GameMenu } from "./types.js";
import {
  buildMainKeyboard,
  buildSubmenuKeyboard,
  buildEstadisticasKeyboard,
  buildIndividualPeriodKeyboard,
  buildDiasDiferenciaKeyboard,
  buildDiasDiferenciaKeyboardIndividual,
  type MainKeyboardDeps,
} from "./keyboards.js";

export interface MenuHandlersDeps extends MainKeyboardDeps {
  helpText: string;
  getHotThresholdDays: () => number;
  setHotThresholdDays: (n: number) => void;
  getP3Map: () => Promise<Record<string, { m?: number[]; e?: number[] }>>;
  getP4Map: () => Promise<Record<string, { m?: number[]; e?: number[] }>>;
  buildGroupStatsMessage: (
    map: Record<string, { m?: number[]; e?: number[] }>,
    days: number,
    period: "M" | "E"
  ) => string;
  buildIndividualTop10Message: (
    map: Record<string, { m?: number[]; e?: number[] }>,
    days: number,
    period: "M" | "E"
  ) => string;
  /** Scrape "Hoy" P3+P4 (cacheado unos minutos). */
  getCachedScrapeToday: () => Promise<{
    p3: { isToday: boolean; key: string; m?: number[]; e?: number[] };
    p4: { isToday: boolean; key: string; m?: number[]; e?: number[] };
  }>;
  buildResultOneDay: (
    key: string,
    d3: { m?: number[]; e?: number[] },
    d4: { m?: number[]; e?: number[] },
    game: GameMenu,
    title: string
  ) => string;
  buildResultWeek: (
    map3: Record<string, { m?: number[]; e?: number[] }>,
    map4: Record<string, { m?: number[]; e?: number[] }>,
    dates: string[],
    game: GameMenu
  ) => string;
  getTodayFloridaMMDDYY: () => string;
  getYesterdayFloridaMMDDYY: () => string;
  getThisWeekFloridaMMDDYY: () => string[];
}

const PICK3_WEB_URL = "https://floridalottery.com/games/draw-games/pick-3";
const PICK4_WEB_URL = "https://floridalottery.com/games/draw-games/pick-4";

function getHoyConsultaLink(game: GameMenu): string {
  if (game === "fijo") return `\n\nConsulta: [Pick 3](${PICK3_WEB_URL})`;
  if (game === "corrido") return `\n\nConsulta: [Pick 4](${PICK4_WEB_URL})`;
  return `\n\nConsulta: [Pick 3](${PICK3_WEB_URL}) · [Pick 4](${PICK4_WEB_URL})`;
}

export async function handleMenuCallback(
  ctx: Context,
  data: string,
  deps: MenuHandlersDeps
): Promise<{ result: string; keyboard: InlineKeyboard } | null> {
  const userId = ctx.from?.id;
  const hot = deps.getHotThresholdDays();
  const mainKb = () => buildMainKeyboard(userId, deps);

  if (data === "help") {
    return { result: "*❓ Ayuda*\n\n" + deps.helpText, keyboard: mainKb() };
  }

  if (data === "volver") {
    return {
      result: "👋 Elige juego y luego el período:",
      keyboard: mainKb(),
    };
  }

  if (data === "menu_fijo") {
    return {
      result: "🎯 *Fijo* (P3)\n\nElige período (☀️ Mediodía y 🌙 Noche):",
      keyboard: buildSubmenuKeyboard("fijo"),
    };
  }
  if (data === "menu_corrido") {
    return {
      result: "🎲 *Corrido* (P4)\n\nElige período (☀️ Mediodía y 🌙 Noche):",
      keyboard: buildSubmenuKeyboard("corrido"),
    };
  }
  if (data === "menu_ambos") {
    return {
      result: "☀️🌙 *Ambos* — Fijo y Corrido\n\nElige período:",
      keyboard: buildSubmenuKeyboard("ambos"),
    };
  }

  if (data === "menu_basedatos") {
    return {
      result:
        "📚 *Base de datos*\n\nEnlaces oficiales Florida Lottery (PDF):\n\n" +
        "• [Fijos \\(P3\\)](https://files.floridalottery.com/exptkt/p3.pdf)\n" +
        "• [Corridos \\(P4\\)](https://files.floridalottery.com/exptkt/p4.pdf)",
      keyboard: new InlineKeyboard().text("◀️ Volver", "volver"),
    };
  }

  if (data === "stats_set_days") {
    return {
      result: `🔢 *Días de diferencia* (valor actual: ${hot})\n\nSi (Máx.hist − Máx.actual) ≤ N, se marca 🔥 Hot. Elige N:`,
      keyboard: buildDiasDiferenciaKeyboard(),
    };
  }
  if (data === "stats_individual_set_days") {
    return {
      result: `🔢 *Días de diferencia* (valor actual: ${hot})\n\nSi (Máx.hist − Máx.actual) ≤ N, se marca 🔥 Hot. Elige N:`,
      keyboard: buildDiasDiferenciaKeyboardIndividual(),
    };
  }
  if (data === "stats_individual_back") {
    return {
      result:
        "📈 *Top 10 más Hot* (números 00-99)\n\nElige *Mediodía (M)* o *Noche (E)*. 🔥 Hot = (Máx.hist − Máx.actual) ≤ Días diferencia.",
      keyboard: buildIndividualPeriodKeyboard(deps.getHotThresholdDays()),
    };
  }
  if (/^stats_individual_days_\d+$/.test(data)) {
    const n = parseInt(data.replace("stats_individual_days_", ""), 10);
    if (n >= 1 && n <= 30) deps.setHotThresholdDays(n);
    await ctx.answerCallbackQuery({ text: `Días diferencia = ${deps.getHotThresholdDays()}` });
    return {
      result:
        "📈 *Top 10 más Hot* (números 00-99)\n\nElige *Mediodía (M)* o *Noche (E)*. 🔥 Hot = (Máx.hist − Máx.actual) ≤ Días diferencia.",
      keyboard: buildIndividualPeriodKeyboard(deps.getHotThresholdDays()),
    };
  }
  if (/^stats_days_\d+$/.test(data)) {
    const n = parseInt(data.replace("stats_days_", ""), 10);
    if (n >= 1 && n <= 30) deps.setHotThresholdDays(n);
    await ctx.answerCallbackQuery({ text: `Días diferencia = ${deps.getHotThresholdDays()}` });
    return {
      result:
        "📊 *Estadísticas por grupos* (Fijo P3)\n\nElige *Mediodía (M)* o *Noche (E)*. Grupos: terminales (0-9), iniciales (0-9), dobles.\n\n🔥 Hot = (Máx.hist − Máx.actual) ≤ Días diferencia.",
      keyboard: buildEstadisticasKeyboard(deps.getHotThresholdDays()),
    };
  }

  if (data === "stats_grupos_M" || data === "stats_grupos_E") {
    const period = data === "stats_grupos_M" ? "M" : "E";
    await ctx.answerCallbackQuery();
    try {
      const map3 = await deps.getP3Map();
      const result = deps.buildGroupStatsMessage(map3, deps.getHotThresholdDays(), period);
      return { result, keyboard: mainKb() };
    } catch (e) {
      console.error("Group stats error:", e);
      return { result: "No pude cargar el historial P3. Prueba más tarde.", keyboard: mainKb() };
    }
  }
  if (data === "stats_individual_M" || data === "stats_individual_E") {
    const period = data === "stats_individual_M" ? "M" : "E";
    await ctx.answerCallbackQuery();
    try {
      const map3 = await deps.getP3Map();
      const result = deps.buildIndividualTop10Message(map3, deps.getHotThresholdDays(), period);
      return { result, keyboard: mainKb() };
    } catch (e) {
      console.error("Individual stats error:", e);
      return { result: "No pude cargar el historial P3. Prueba más tarde.", keyboard: mainKb() };
    }
  }

  const match = data.match(/^(fijo|corrido|ambos)_(hoy|ayer|semana)$/);
  if (match) {
    const [, gameStr, scope] = match as [string, GameMenu, "hoy" | "ayer" | "semana"];
    const game = gameStr as GameMenu;
    const label = game === "fijo" ? "Fijo" : game === "corrido" ? "Corrido" : "Fijo y Corrido";
    await ctx.answerCallbackQuery({ text: `Cargando ${label}…` });
    try {
      let result: string;
      if (scope === "hoy") {
        try {
          const { p3, p4 } = await deps.getCachedScrapeToday();
          if (!p3.isToday || !p4.isToday) {
            result = "☀️🌙 *Hoy*\n\nNo hay datos disponible aún." + getHoyConsultaLink(game);
            return { result, keyboard: mainKb() };
          }
          const key = p3.key;
          const d3 = { m: p3.m, e: p3.e };
          const d4 = { m: p4.m, e: p4.e };
          result = deps.buildResultOneDay(key, d3, d4, game, "Hoy");
          return { result, keyboard: mainKb() };
        } catch (scrapeErr) {
          const msg = scrapeErr instanceof Error ? scrapeErr.message : String(scrapeErr);
          if (msg.includes("Puppeteer not available")) {
            console.log("[Hoy] Usando PDF (Puppeteer no disponible en este entorno).");
          } else {
            console.warn("Scrape Hoy no disponible (ej. Puppeteer no instalado), usando PDF:", scrapeErr);
          }
          try {
            const [map3, map4] = await Promise.all([deps.getP3Map(), deps.getP4Map()]);
            const key = deps.getTodayFloridaMMDDYY();
            const d3 = map3[key] ?? {};
            const d4 = map4[key] ?? {};
            result = deps.buildResultOneDay(key, d3, d4, game, "Hoy") + getHoyConsultaLink(game);
          } catch {
            result = "☀️🌙 *Hoy*\n\nNo pude obtener los resultados de hoy." + getHoyConsultaLink(game);
          }
          return { result, keyboard: mainKb() };
        }
      }
      const [map3, map4] = await Promise.all([deps.getP3Map(), deps.getP4Map()]);
      if (scope === "ayer") {
        const key = deps.getYesterdayFloridaMMDDYY();
        const d3 = map3[key] ?? {};
        const d4 = map4[key] ?? {};
        result = deps.buildResultOneDay(key, d3, d4, game, "Ayer");
      } else {
        const dates = deps.getThisWeekFloridaMMDDYY();
        result = deps.buildResultWeek(map3, map4, dates, game);
      }
      return { result, keyboard: mainKb() };
    } catch (e) {
      console.error("PDF map error:", e);
      return { result: "No pude cargar los PDF. Prueba más tarde.", keyboard: mainKb() };
    }
  }

  return null;
}
