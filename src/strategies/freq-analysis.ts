/**
 * Estrategia 1 — Radar de Frecuencias Absoluta
 *
 * Cuenta cuántas veces ha salido cada número (00-99) en toda la historia disponible.
 * Identifica los 20 más frecuentes ("calientes") y los 10 más fríos, junto con la
 * probabilidad porcentual y los días transcurridos desde la última aparición.
 *
 * Id: freq_analysis
 */

import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";
import {
  mmddyyToDate,
  twoDigitNumbers,
  truncateMsg,
  validDateKeys,
  getDateRangeStr,
  getStrategiesTopN,
} from "./utils.js";

interface NumStat {
  num: number;
  count: number;
  lastDate: Date | null;
  lastDateStr: string;
  daysSince: number;
}

function computeFrequency(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): { stats: NumStat[]; totalOccurrences: number; totalDraws: number } {
  const minLen = mapSource === "p4" ? 4 : 3;
  const dates = validDateKeys(map, period, mapSource);

  const counts = new Map<number, number>();
  const lastSeenDate = new Map<number, Date>();
  const lastSeenStr = new Map<number, string>();

  for (let n = 0; n < 100; n++) counts.set(n, 0);

  for (const dateStr of dates) {
    const draw = map[dateStr]?.[period];
    if (!draw || draw.length < minLen) continue;
    const date = mmddyyToDate(dateStr);
    if (!date) continue;

    for (const num of twoDigitNumbers(draw, mapSource)) {
      if (num < 0 || num > 99) continue;
      counts.set(num, (counts.get(num) ?? 0) + 1);
      const prev = lastSeenDate.get(num);
      if (!prev || date > prev) {
        lastSeenDate.set(num, date);
        lastSeenStr.set(num, dateStr);
      }
    }
  }

  const today = new Date();
  let totalOccurrences = 0;
  for (const c of counts.values()) totalOccurrences += c;

  const stats: NumStat[] = [];
  for (let n = 0; n < 100; n++) {
    const lastDate = lastSeenDate.get(n) ?? null;
    stats.push({
      num: n,
      count: counts.get(n) ?? 0,
      lastDate,
      lastDateStr: lastSeenStr.get(n) ?? "N/A",
      daysSince: lastDate
        ? Math.floor((today.getTime() - lastDate.getTime()) / 86_400_000)
        : 9999,
    });
  }

  return { stats, totalOccurrences, totalDraws: dates.length };
}

function formatMessage(
  stats: NumStat[],
  totalOccurrences: number,
  totalDraws: number,
  mapSource: "p3" | "p4",
  period: "m" | "e",
  rangeStr: string
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  const topN = getStrategiesTopN();
  const byFreq = [...stats].sort((a, b) => b.count - a.count);
  const topHot = byFreq.slice(0, topN);
  const topCold = [...stats].sort((a, b) => a.count - b.count).slice(0, topN);

  const pct = (c: number) =>
    totalOccurrences > 0 ? ((c / totalOccurrences) * 100).toFixed(2) : "0.00";

  const lines: string[] = [
    `📊 *Radar de Frecuencias* — ${mapLabel} · ${periodLabel}`,
    `Sorteos: ${totalDraws} · Período: ${rangeStr} · Apariciones totales: ${totalOccurrences}`,
    "",
    `📖 _Qué mide:_ cuáles son los números que más repiten y los que menos salen en la historia\\.`,
    "_Count_ = apariciones \u00b7 _Prob%_ = probabilidad histórica \u00b7 _Días sin_ = días desde última salida",
    `_TOP ${topN} calientes_ = más frecuentes \u00b7 _TOP ${topN} fríos_ = candidatos por larga ausencia`,
    "",
    "```",
    `TOP ${topN} MÁS FRECUENTES`,
    " #  Num  Count  Prob%   Días sin",
    "─────────────────────────────────────",
  ];

  topHot.forEach((s, i) => {
    const n = String(s.num).padStart(2, "0");
    const c = String(s.count).padStart(4);
    const p = pct(s.count).padStart(5);
    const d = s.daysSince < 9999 ? `${s.daysSince}d` : "nunca";
    lines.push(`${String(i + 1).padStart(2)}  ${n}   ${c}   ${p}%  ${d}`);
  });

  lines.push("");
  lines.push(`TOP ${topN} MÁS FRÍOS (menos salidores)`);
  lines.push(" #  Num  Count  Prob%   Días sin");
  lines.push("─────────────────────────────────────");

  topCold.forEach((s, i) => {
    const n = String(s.num).padStart(2, "0");
    const c = String(s.count).padStart(4);
    const p = pct(s.count).padStart(5);
    const d = s.daysSince < 9999 ? `${s.daysSince}d` : "nunca";
    lines.push(`${String(i + 1).padStart(2)}  ${n}   ${c}   ${p}%  ${d}`);
  });

  lines.push("```");
  return truncateMsg(lines.join("\n").trimEnd());
}

export const freqAnalysis: StrategyDefinition = {
  id: "freq_analysis",
  description: "Cuenta cuáles son los números que más han salido en la historia (los favoritos) y cuáles son los que menos salen (los más fríos).",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,
  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const { stats, totalOccurrences, totalDraws } = computeFrequency(
      map,
      context.period,
      context.mapSource
    );
    const rangeStr = getDateRangeStr(map, context.period, context.mapSource);
    return formatMessage(stats, totalOccurrences, totalDraws, context.mapSource, context.period, rangeStr);
  },
  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const { stats } = computeFrequency(map, context.period, context.mapSource);
    return stats
      .filter((s) => s.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, getStrategiesTopN())
      .map((s) => s.num);
  },
};
