/**
 * Estrategia — Análisis de Terminales (Dígito Final)
 *
 * Se enfoca en el dígito de unidad (0-9) de los números que salen en cada sorteo.
 * El "terminal" es el último dígito: en el número 47, el terminal es 7.
 *
 * Análisis que realiza:
 *   1. Ranking de terminales por frecuencia histórica y reciente (últimos 30 sorteos)
 *   2. Momentum por terminal: detecta cuáles están en alza o en baja
 *   3. Factor de deuda por terminal: cuántos sorteos lleva sin aparecer vs su promedio
 *   4. Para los terminales más calientes/debidos: listado de candidatos completos
 *      (los números 00-99 con ese terminal, ordenados por frecuencia propia)
 *
 * A diferencia del análisis posicional (que estudia el dígito U como una de tres
 * posiciones independientes), esta estrategia eleva el terminal al eje central
 * del análisis y proyecta los candidatos completos que lo contienen.
 *
 *   P3 (Fijo): terminal del número twoDigit (dígito de unidad de BC en ABC)
 *   P4 (Corrido): terminal del Par1 (AB) y del Par2 (CD) por separado
 *
 * Id: terminal_analysis
 */

import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";
import {
  twoDigitNumbers,
  truncateMsg,
  validDateKeys,
  getDateRangeStr,
} from "./utils.js";

const RECENT_WINDOW = 30;

interface TerminalStat {
  terminal: number; // 0-9
  countAll: number;
  countRecent: number;
  drawsAll: number;
  drawsRecent: number;
  freqAll: number;
  freqRecent: number;
  momentum: number;
  /** Consecutive draws since terminal last appeared */
  drawsSince: number;
  avgDrawsBetween: number;
  dueFactor: number;
  /** Top numbers (00-99) ending in this terminal, by historical count */
  topNums: { num: number; count: number }[];
}

function computeTerminals(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): TerminalStat[] {
  const minLen = mapSource === "p4" ? 4 : 3;
  const allDates = validDateKeys(map, period, mapSource);
  const recentDates = allDates.slice(-RECENT_WINDOW);

  // Terminal counts per draw
  const termCountAll = new Array<number>(10).fill(0);
  const termCountRecent = new Array<number>(10).fill(0);
  const numCountAll = new Array<number>(100).fill(0);

  // For due calculation: index of last draw where each terminal appeared
  const termLastDrawIdx = new Array<number>(10).fill(-1);
  // Gaps (in number of draws) between appearances
  const termDrawGaps: number[][] = Array.from({ length: 10 }, () => []);
  let prevTermAppearIdx = new Array<number>(10).fill(-1);

  for (let i = 0; i < allDates.length; i++) {
    const dateStr = allDates[i]!;
    const draw = map[dateStr]?.[period];
    if (!draw || draw.length < minLen) continue;

    const nums = twoDigitNumbers(draw, mapSource);
    const seenTerminals = new Set<number>();

    for (const num of nums) {
      if (num < 0 || num > 99) continue;
      const term = num % 10;
      numCountAll[num]++;
      termCountAll[term]++;
      seenTerminals.add(term);
    }

    for (const term of seenTerminals) {
      if (prevTermAppearIdx[term]! >= 0) {
        termDrawGaps[term]!.push(i - prevTermAppearIdx[term]!);
      }
      prevTermAppearIdx[term] = i;
      termLastDrawIdx[term] = i;
    }
  }

  // Recent counts
  for (const dateStr of recentDates) {
    const draw = map[dateStr]?.[period];
    if (!draw || draw.length < minLen) continue;
    const seenTerminals = new Set<number>();
    for (const num of twoDigitNumbers(draw, mapSource)) {
      if (num >= 0 && num <= 99) seenTerminals.add(num % 10);
    }
    for (const term of seenTerminals) termCountRecent[term]++;
  }

  const totalDraws = allDates.length;
  const lastDrawIdx = totalDraws - 1;

  const stats: TerminalStat[] = [];

  for (let t = 0; t < 10; t++) {
    const ca = termCountAll[t]!;
    const cr = termCountRecent[t]!;
    const fa = totalDraws > 0 ? ca / totalDraws : 0;
    const fr = recentDates.length > 0 ? cr / recentDates.length : 0;
    const momentum = fa > 0 ? fr / fa : cr > 0 ? 10 : 0;

    const gaps = termDrawGaps[t]!;
    const avgDrawsBetween = gaps.length > 0 ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
    const drawsSince = termLastDrawIdx[t]! >= 0 ? lastDrawIdx - termLastDrawIdx[t]! : 9999;
    const dueFactor = avgDrawsBetween > 0 ? drawsSince / avgDrawsBetween : 0;

    // Top 5 numbers ending in t, by total count
    const topNums: { num: number; count: number }[] = [];
    for (let n = t; n < 100; n += 10) {
      if (numCountAll[n]! > 0) topNums.push({ num: n, count: numCountAll[n]! });
    }
    topNums.sort((a, b) => b.count - a.count);

    stats.push({
      terminal: t,
      countAll: ca,
      countRecent: cr,
      drawsAll: totalDraws,
      drawsRecent: recentDates.length,
      freqAll: fa,
      freqRecent: fr,
      momentum,
      drawsSince,
      avgDrawsBetween,
      dueFactor,
      topNums: topNums.slice(0, 5),
    });
  }

  return stats;
}

function momentumLabel(m: number): string {
  if (m >= 2.0) return "↑↑↑";
  if (m >= 1.5) return "↑↑ ";
  if (m >= 1.0) return "↑  ";
  if (m === 0) return "—  ";
  return "↓  ";
}

function formatMessage(
  stats: TerminalStat[],
  mapSource: "p3" | "p4",
  period: "m" | "e",
  rangeStr: string
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  const byMomentum = [...stats].sort((a, b) => b.momentum - a.momentum);
  const byDue = [...stats]
    .filter((s) => s.dueFactor > 0)
    .sort((a, b) => b.dueFactor - a.dueFactor);

  const lines: string[] = [
    `📊 *Análisis de Terminales* — ${mapLabel} · ${periodLabel}`,
    `Período: ${rangeStr}`,
    "",
    "📖 _Qué mide:_ el dígito final \\(terminal, 0\\-9\\) de los números sorteados\\.",
    "_Momento_ = frec\\. reciente ÷ histórica\\. _Due_ = sorteos sin salir ÷ promedio\\.",
    "Detecta qué terminal está en alza y proyecta los candidatos que lo contienen\\.",
    "",
    "```",
    "TERMINALES POR MOMENTUM",
    "Term  Rec%    Hist%   Moment.  Due     DrawsSin",
    "──────────────────────────────────────────────────",
  ];

  for (const s of byMomentum) {
    const rec = `${(s.freqRecent * 100).toFixed(1)}%`.padStart(6);
    const hist = `${(s.freqAll * 100).toFixed(1)}%`.padStart(6);
    const mom = s.momentum >= 10 ? " nuevo↑" : `${s.momentum.toFixed(1)}x`.padStart(6);
    const ml = momentumLabel(s.momentum);
    const due = s.avgDrawsBetween > 0 ? `${s.dueFactor.toFixed(1)}x` : "  — ";
    const ds = s.drawsSince < 9999 ? `${s.drawsSince}` : "nunca";
    lines.push(` _${s.terminal}   ${rec}  ${hist}  ${mom} ${ml}  ${due.padStart(5)}   ${ds}`);
  }

  lines.push("");
  lines.push("TERMINALES MÁS DEBIDOS (en sorteos)");
  lines.push("Term  DrawsSin  AvgEntre  Due");
  lines.push("────────────────────────────────────");
  for (const s of byDue.slice(0, 5)) {
    const ds = s.drawsSince < 9999 ? `${s.drawsSince}` : "nunca";
    const avg = s.avgDrawsBetween.toFixed(1);
    const due = `${s.dueFactor.toFixed(1)}x`;
    lines.push(` _${s.terminal}   ${ds.padStart(7)}   ${avg.padStart(7)}   ${due}`);
  }

  lines.push("");
  lines.push("CANDIDATOS POR TERMINAL CALIENTE (momentum ≥ 1.0)");

  const hotTerminals = byMomentum.filter((s) => s.momentum >= 1.0).slice(0, 3);
  if (hotTerminals.length === 0) {
    lines.push("  Sin terminales con momentum suficiente.");
  } else {
    for (const s of hotTerminals) {
      const momStr = s.momentum >= 10 ? "nuevo↑" : `${s.momentum.toFixed(1)}x`;
      const nums = s.topNums.map((x) => `${String(x.num).padStart(2, "0")}(${x.count}x)`).join("  ");
      lines.push(`  Terminal _${s.terminal}_ [${momStr}]: ${nums}`);
    }
  }

  lines.push("");
  lines.push("CANDIDATOS POR TERMINAL DEBIDO (due ≥ 1.5)");

  const dueTerminals = byDue.filter((s) => s.dueFactor >= 1.5).slice(0, 3);
  if (dueTerminals.length === 0) {
    lines.push("  Sin terminales con deuda significativa.");
  } else {
    for (const s of dueTerminals) {
      const nums = s.topNums.map((x) => `${String(x.num).padStart(2, "0")}(${x.count}x)`).join("  ");
      lines.push(`  Terminal _${s.terminal}_ [${s.dueFactor.toFixed(1)}x due]: ${nums}`);
    }
  }

  lines.push("");
  lines.push("↑↑↑≥2x momentum · Due≥2x = terminal muy atrasado");
  lines.push("```");

  return truncateMsg(lines.join("\n").trimEnd());
}

export const terminalAnalysis: StrategyDefinition = {
  id: "terminal_analysis",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,

  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const stats = computeTerminals(map, context.period, context.mapSource);
    const rangeStr = getDateRangeStr(map, context.period, context.mapSource);
    return formatMessage(stats, context.mapSource, context.period, rangeStr);
  },

  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const stats = computeTerminals(map, context.period, context.mapSource);

    // Top terminals by a blend of momentum and due
    const scored = stats.map((s) => ({
      ...s,
      score: s.momentum * 0.6 + Math.min(s.dueFactor, 3) * 0.4,
    }));
    scored.sort((a, b) => b.score - a.score);

    const seen = new Set<number>();
    const result: number[] = [];

    for (const s of scored.slice(0, 4)) {
      for (const x of s.topNums) {
        if (!seen.has(x.num)) { seen.add(x.num); result.push(x.num); }
      }
    }
    return result.slice(0, 20);
  },
};
