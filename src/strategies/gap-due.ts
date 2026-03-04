/**
 * Estrategia 2 — Números Debidos (Gap Analysis)
 *
 * Para cada número calcula:
 *   - Brecha promedio entre apariciones (días)
 *   - Brecha máxima histórica
 *   - Días transcurridos desde la última aparición (brecha actual)
 *   - Factor de deuda = brecha_actual / brecha_promedio
 *
 * Un factor > 1 indica que el número lleva más tiempo del usual sin salir
 * y estadísticamente está "debido". Factores muy altos (≥ 2x) indican
 * números que casi doblan su promedio sin aparecer.
 *
 * Id: gap_due
 */

import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";
import {
  mmddyyToDate,
  twoDigitNumbers,
  truncateMsg,
  validDateKeys,
  DAY_NAMES,
} from "./utils.js";

interface GapStat {
  num: number;
  appearances: number;
  avgGap: number;
  maxGap: number;
  currentGap: number;
  dueFactor: number;
  lastDateStr: string;
}

function computeGaps(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): { stats: GapStat[]; latestDateStr: string; latestDate: Date | null } {
  const minLen = mapSource === "p4" ? 4 : 3;
  const sortedDates = validDateKeys(map, period, mapSource);

  const appearances = new Map<number, Date[]>();
  for (let n = 0; n < 100; n++) appearances.set(n, []);

  for (const dateStr of sortedDates) {
    const draw = map[dateStr]?.[period];
    if (!draw || draw.length < minLen) continue;
    const date = mmddyyToDate(dateStr);
    if (!date) continue;

    for (const num of twoDigitNumbers(draw, mapSource)) {
      if (num >= 0 && num <= 99) appearances.get(num)!.push(date);
    }
  }

  const today = new Date();
  const latestDateStr = sortedDates.at(-1) ?? "";
  const latestDate = latestDateStr ? mmddyyToDate(latestDateStr) : null;

  const stats: GapStat[] = [];

  for (let n = 0; n < 100; n++) {
    const dates = appearances.get(n)!.sort((a, b) => a.getTime() - b.getTime());

    if (dates.length === 0) {
      stats.push({
        num: n,
        appearances: 0,
        avgGap: 0,
        maxGap: 0,
        currentGap: 9999,
        dueFactor: 0,
        lastDateStr: "N/A",
      });
      continue;
    }

    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(
        Math.floor((dates[i]!.getTime() - dates[i - 1]!.getTime()) / 86_400_000)
      );
    }

    const avgGap =
      gaps.length > 0 ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
    const maxGap = gaps.length > 0 ? Math.max(...gaps) : 0;

    const lastDate = dates.at(-1)!;
    const currentGap = Math.floor(
      (today.getTime() - lastDate.getTime()) / 86_400_000
    );
    const dueFactor = avgGap > 0 ? currentGap / avgGap : 0;

    const mm = String(lastDate.getMonth() + 1).padStart(2, "0");
    const dd = String(lastDate.getDate()).padStart(2, "0");
    const yy = String(lastDate.getFullYear()).slice(-2);

    stats.push({
      num: n,
      appearances: dates.length,
      avgGap,
      maxGap,
      currentGap,
      dueFactor,
      lastDateStr: `${mm}/${dd}/${yy}`,
    });
  }

  return { stats, latestDateStr, latestDate };
}

function formatMessage(
  stats: GapStat[],
  latestDateStr: string,
  latestDate: Date | null,
  mapSource: "p3" | "p4",
  period: "m" | "e"
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  let nextDateStr = "N/A";
  if (latestDate) {
    const next = new Date(latestDate);
    next.setDate(next.getDate() + 1);
    const mm = String(next.getMonth() + 1).padStart(2, "0");
    const dd = String(next.getDate()).padStart(2, "0");
    const yy = String(next.getFullYear()).slice(-2);
    nextDateStr = `${mm}/${dd}/${yy} (${DAY_NAMES[next.getDay()]})`;
  }

  // Only numbers with enough appearances for reliable statistics
  const sorted = [...stats]
    .filter((s) => s.appearances >= 3 && s.dueFactor > 0)
    .sort((a, b) => b.dueFactor - a.dueFactor)
    .slice(0, 20);

  const icon = (f: number) =>
    f >= 2.0 ? "🔴" : f >= 1.5 ? "🟠" : f >= 1.0 ? "🟡" : "🟢";

  const lines: string[] = [
    `📊 *Números Debidos (Gap Analysis)* — ${mapLabel} · ${periodLabel}`,
    `Último: ${latestDateStr} · Próx. estimado: ${nextDateStr}`,
    "",
    "📖 _Qué mide:_ cuánto tiempo lleva sin salir cada número respecto a su ritmo histórico\\.",
    "_DíasSin_ ÷ _Prom_ = _Factor_ · Factor >1x = lleva más del promedio sin aparecer",
    "🔴 ≥2x muy debido · 🟠 ≥1\\.5x · 🟡 ≥1x · Un factor alto = fuerte candidato al próximo sorteo",
    "",
    "```",
    "TOP 20 NÚMEROS MÁS DEBIDOS",
    "Num  Últ.Vez   DíasSin  Prom   Factor",
    "──────────────────────────────────────",
  ];

  for (const s of sorted) {
    const n = String(s.num).padStart(2, "0");
    const last = s.lastDateStr.padEnd(9);
    const cur = String(s.currentGap).padStart(6);
    const avg = s.avgGap.toFixed(1).padStart(5);
    const factor = `${s.dueFactor.toFixed(2)}x`;
    lines.push(`${n}   ${last}  ${cur}   ${avg}   ${factor} ${icon(s.dueFactor)}`);
  }

  lines.push("");
  lines.push("🔴 ≥2.0x muy debido · 🟠 ≥1.5x · 🟡 ≥1.0x · 🟢 normal");
  lines.push("```");

  return truncateMsg(lines.join("\n").trimEnd());
}

export const gapDue: StrategyDefinition = {
  id: "gap_due",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,
  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const { stats, latestDateStr, latestDate } = computeGaps(
      map,
      context.period,
      context.mapSource
    );
    return formatMessage(stats, latestDateStr, latestDate, context.mapSource, context.period);
  },
  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const { stats } = computeGaps(map, context.period, context.mapSource);
    return stats
      .filter((s) => s.appearances >= 3 && s.dueFactor >= 1.0)
      .sort((a, b) => b.dueFactor - a.dueFactor)
      .slice(0, 20)
      .map((s) => s.num);
  },
};
