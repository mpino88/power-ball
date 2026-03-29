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
  buildConsultarDatosKeyboard,
  buildEstadisticasKeyboard,
  buildIndividualPeriodKeyboard,
  buildDiasDiferenciaKeyboard,
  buildDiasDiferenciaKeyboardIndividual,
  buildEstrategiasKeyboard,
  buildTopNKeyboard,
  buildTopNMenuMessage,
  CONSULTAR_DATOS_CALLBACK,
  ESTRATEGIAS_OPEN_CALLBACK,
  buildMainMenuMessage,
  type MainKeyboardDeps,
  type UserStatus,
} from "./keyboards.js";
import { getHoyResult } from "../hoy-results.js";
import { findWinningStrategies } from "../neuro-hit-engine.js";
import { getUserTopN, setUserTopN } from "../strategies/utils.js";
import { escapeMd } from "../security/callbacks.js";
import { resolveLatestDraw } from "../draw-resolver.js";

export interface MenuHandlersDeps extends MainKeyboardDeps {
  /** Genera el texto de ayuda a partir del nombre de plan actual del usuario. */
  buildHelpText: (planName: string) => string;
  /** Recarga la config desde el Sheet (o archivo) para reflejar cambios de plan aprobados. */
  reloadUserConfig: () => Promise<void>;
  /** ID numérico del dueño (BOT_OWNER_ID). Si está definido, aparece botón de contacto directo en la ayuda. */
  ownerUserId?: number;
  getHotThresholdDays: () => number;
  setHotThresholdDays: (n: number) => void;
  /** @deprecated Configuración ahora es per-user (getUserTopN/setUserTopN). Mantenida por compatibilidad. */
  getStrategiesTopN: () => number;
  setStrategiesTopN: (n: number) => void;
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
    await deps.reloadUserConfig();
    const planName = (userId !== undefined ? deps.getPlan?.(userId) : undefined) ?? "Básico";
    const kb = mainKb();
    if (deps.ownerUserId) {
      kb.row().url("📩 Contactar al administrador", `tg://user?id=${deps.ownerUserId}`);
    }
    return { result: "*❓ Ayuda*\n\n" + deps.buildHelpText(planName), keyboard: kb };
  }

  if (data === "volver") {
    await deps.reloadUserConfig();
    const [p3, p4] = await Promise.all([deps.getP3Map(), deps.getP4Map()]);
    const { buildRecentDrawsDisplay } = await import("../recent-draws.js");
    const { getHoyResult } = await import("../hoy-results.js");
    const recentDrawsText = buildRecentDrawsDisplay(p3, p4, deps.getTodayFloridaMMDDYY(), deps.getYesterdayFloridaMMDDYY(), getHoyResult());
    const uid = ctx.from?.id;
    const status: UserStatus = !uid ? "visitor"
      : deps.isOwner(uid) ? "admin"
      : (deps.hasPlan?.(uid) ?? false) ? "verified"
      : (deps.isRegistered?.(uid) ?? false) ? "registered"
      : "visitor";
    return {
      result: buildMainMenuMessage(ctx.from?.first_name || "Usuario", recentDrawsText, status),
      keyboard: mainKb(),
    };
  }

  // ── Top-N: resultados por estrategia (por usuario) ────────────────────────
  if (data === "topn_open") {
    const current = getUserTopN(userId ?? 0);
    return {
      result: buildTopNMenuMessage(current),
      keyboard: buildTopNKeyboard(current),
    };
  }
  if (/^topn_set_\d+$/.test(data)) {
    const n = parseInt(data.replace("topn_set_", ""), 10);
    if (userId) setUserTopN(userId, n);
    const updated = getUserTopN(userId ?? 0);
    await ctx.answerCallbackQuery({ text: `🔢 Resultados por estrategia: ${updated}` });
    return {
      result: buildTopNMenuMessage(updated),
      keyboard: buildTopNKeyboard(updated),
    };
  }
  // ── fin Top-N ──────────────────────────────────────────────────────────────

  if (data === CONSULTAR_DATOS_CALLBACK) {
    return {
      result: "👋 Resultados Fijo (P3) y Corrido (P4) de Florida Lottery.\n\nElige juego y luego el período:",
      keyboard: buildConsultarDatosKeyboard(),
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
    const P3_PDF = "https://files.floridalottery.com/exptkt/p3.pdf";
    const P4_PDF = "https://files.floridalottery.com/exptkt/p4.pdf";
    return {
      result: "📚 *Base de datos*\n\nEnlaces oficiales Florida Lottery (PDF). Pulsa el botón para abrir:",
      keyboard: new InlineKeyboard()
        .url("🎯 Fijos (P3)", P3_PDF)
        .url("🎲 Corridos (P4)", P4_PDF)
        .row()
        .text("◀️ Volver", CONSULTAR_DATOS_CALLBACK),
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
      const todayKey = deps.getTodayFloridaMMDDYY();
      const yesterdayKey = deps.getYesterdayFloridaMMDDYY();

      if (scope === "hoy") {
        const hoyData = getHoyResult();
        const [p3Map, p4Map] = await Promise.all([deps.getP3Map(), deps.getP4Map()]);
        const maps = { p3: p3Map, p4: p4Map };
        const dates = { today: todayKey, yesterday: yesterdayKey };

        // 1. Resolvemos los resultados (Hoy o Fallback Ayer)
        const resMP3 = resolveLatestDraw("p3", "m", maps, dates, hoyData);
        const resMP4 = resolveLatestDraw("p4", "m", maps, dates, hoyData);
        const resEP3 = resolveLatestDraw("p3", "e", maps, dates, hoyData);
        const resEP4 = resolveLatestDraw("p4", "e", maps, dates, hoyData);

        // 2. Auditamos los "Hits" basados en los resultados efectivamente resueltos
        const winningHits = await findWinningStrategies(
          { getP3Map: deps.getP3Map, getP4Map: deps.getP4Map },
          deps.getHotThresholdDays(),
          {
            p3_m: resMP3.draw.replace(/-/g, ""),
            p3_e: resEP3.draw.replace(/-/g, ""),
            p4_m: resMP4.draw.replace(/-/g, ""),
            p4_e: resEP4.draw.replace(/-/g, ""),
          }
        );

        const formatDrawBold = (v: string | undefined) => {
          if (!v || v === "---") return "_---_";
          if (v.includes("-")) return `*${v}*`;
          if (v.length === 3 || v.length === 4) return `*${v.split("").join("-")}*`;
          return `*${v}*`;
        };

        const renderHitsConditional = (hits: { id: string; label: string }[]) => {
          if (hits.length === 0) return `\n⚡ Algoritmos Validados: _Auditando estrategia..._`;
          const uniqueLabels = [...new Set(hits.map(h => escapeMd(deps.getExtraMenuLabel?.(h.label) || h.label)))];
          return `\n⚡ *Algoritmos Validados:*\n` + uniqueLabels.map(l => ` ➥ ${l}`).join("\n");
        };

        const title = game === "fijo" ? "Fijo (P3)" : (game === "corrido" ? "Corrido (P4)" : "Fijo y Corrido");
        let output = `*Últimos Sorteos 🏆 (${title})*\n\n`;

        // --- MEDIODÍA ---
        output += `☀️ MEDIODÍA ${resMP3.label}\n\n`;
        if (game === "fijo" || game === "ambos") {
          output += ` 🎯 Fijo (P3): ${formatDrawBold(resMP3.draw)}${renderHitsConditional(winningHits.p3_m)}\n\n`;
        }
        if (game === "corrido" || game === "ambos") {
          output += ` 🎲 Corrido (P4): ${formatDrawBold(resMP4.draw)}${renderHitsConditional(winningHits.p4_m)}\n\n`;
        }

        // --- NOCHE ---
        output += `🌙 NOCHE ${resEP3.label}\n\n`;
        if (game === "fijo" || game === "ambos") {
          output += ` 🎯 Fijo (P3): ${formatDrawBold(resEP3.draw)}${renderHitsConditional(winningHits.p3_e)}\n\n`;
        }
        if (game === "corrido" || game === "ambos") {
          output += ` 🎲 Corrido (P4): ${formatDrawBold(resEP4.draw)}${renderHitsConditional(winningHits.p4_e)}\n\n`;
        }

        result = output.trim() + getHoyConsultaLink(game);
      } else {
        const [map3, map4] = await Promise.all([deps.getP3Map(), deps.getP4Map()]);
        if (scope === "ayer") {
          const d3 = map3[yesterdayKey] ?? {};
          const d4 = map4[yesterdayKey] ?? {};
          result = deps.buildResultOneDay(yesterdayKey, d3, d4, game, "Ayer");
        } else {
          const dates = deps.getThisWeekFloridaMMDDYY();
          result = deps.buildResultWeek(map3, map4, dates, game);
        }
      }
      return { result, keyboard: mainKb() };
    } catch (e) {
      console.error("Menu handler error:", e);
      return { result: "No pude procesar la consulta. Prueba más tarde.", keyboard: mainKb() };
    }
  }

  return null;
}
