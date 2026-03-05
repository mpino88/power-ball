/**
 * Estrategia — Análisis de Familias de Decenas
 *
 * Agrupa los 100 números en 10 "familias" de decena:
 *   D0 = 00-09 · D1 = 10-19 · D2 = 20-29 · ... · D9 = 90-99
 *
 * Para cada familia calcula:
 *   - Frecuencia histórica total (apariciones en toda la base)
 *   - Frecuencia reciente (últimos 30 sorteos)
 *   - Momentum: frecuencia_reciente ÷ frecuencia_histórica (>1 = en alza)
 *   - Factor de deuda: días sin que salga ningún número de esa familia
 *
 * Identifica qué familia está en alza (momentum alto) y cuál está debida
 * (mayor brecha). Dentro de cada familia candidata muestra los TOP-5 números
 * individuales con mayor respaldo propio.
 *
 * Análisis de dos niveles: primero elige la familia más probable, luego
 * proyecta los números más fuertes dentro de ella. Complementa al análisis
 * posicional (que trabaja dígito a dígito) aportando una visión de grupo.
 *
 * Id: decade_family
 */

import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";
import {
  mmddyyToDate,
  twoDigitNumbers,
  truncateMsg,
  validDateKeys,
  getDateRangeStr,
} from "./utils.js";

const RECENT_WINDOW = 30;

interface FamilyStat {
  family: number; // 0-9
  label: string;  // "D0 (00-09)"
  countAll: number;
  countRecent: number;
  freqAll: number;
  freqRecent: number;
  momentum: number;
  currentGapDays: number;
  avgGapDays: number;
  dueFactor: number;
  lastDateStr: string;
  /** Top individual numbers within this family */
  topNums: { num: number; count: number }[];
}

function computeDecadeFamilies(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): { families: FamilyStat[]; latestDateStr: string } {
  const minLen = mapSource === "p4" ? 4 : 3;
  const allDates = validDateKeys(map, period, mapSource);
  const recentDates = allDates.slice(-RECENT_WINDOW);

  // Per-family: count of appearances (total & recent)
  const famCountAll = new Array<number>(10).fill(0);
  const famCountRecent = new Array<number>(10).fill(0);
  // Per-family: last appearance dates (for gap calculation)
  const famLastDate = new Array<Date | null>(10).fill(null);
  const famAppearDates = Array.from({ length: 10 }, () => [] as Date[]);

  // Per-number: total count
  const numCountAll = new Array<number>(100).fill(0);

  const accumulate = (dates: string[], famTarget: number[], numTarget?: number[]) => {
    for (const dateStr of dates) {
      const draw = map[dateStr]?.[period];
      if (!draw || draw.length < minLen) continue;
      const date = mmddyyToDate(dateStr);
      if (!date) continue;

      for (const num of twoDigitNumbers(draw, mapSource)) {
        if (num < 0 || num > 99) continue;
        const fam = Math.floor(num / 10);
        famTarget[fam]++;
        if (numTarget) numTarget[num]++;
        // Track dates only for all-time
        if (numTarget) {
          const prev = famLastDate[fam];
          if (!prev || date > prev) famLastDate[fam] = date;
          famAppearDates[fam]!.push(date);
        }
      }
    }
  };

  accumulate(allDates, famCountAll, numCountAll);
  accumulate(recentDates, famCountRecent);

  const today = new Date();
  const totalAll = allDates.length;
  const totalRecent = recentDates.length;
  const latestDateStr = allDates.at(-1) ?? "";

  const families: FamilyStat[] = [];

  for (let f = 0; f < 10; f++) {
    const ca = famCountAll[f]!;
    const cr = famCountRecent[f]!;
    const fa = totalAll > 0 ? ca / totalAll : 0;
    const fr = totalRecent > 0 ? cr / totalRecent : 0;
    const momentum = fa > 0 ? fr / fa : cr > 0 ? 10 : 0;

    // Gap calculation (sort dates for this family)
    const sortedFamDates = famAppearDates[f]!
      .slice()
      .sort((a, b) => a.getTime() - b.getTime());
    const gaps: number[] = [];
    for (let i = 1; i < sortedFamDates.length; i++) {
      gaps.push(
        Math.floor((sortedFamDates[i]!.getTime() - sortedFamDates[i - 1]!.getTime()) / 86_400_000)
      );
    }
    const avgGapDays = gaps.length > 0 ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
    const lastDate = famLastDate[f];
    const currentGapDays = lastDate
      ? Math.floor((today.getTime() - lastDate.getTime()) / 86_400_000)
      : 9999;
    const dueFactor = avgGapDays > 0 ? currentGapDays / avgGapDays : 0;

    const ld = lastDate;
    const lastDateStr = ld
      ? `${String(ld.getMonth() + 1).padStart(2, "0")}/${String(ld.getDate()).padStart(2, "0")}/${String(ld.getFullYear()).slice(-2)}`
      : "N/A";

    // Top 5 numbers in this family by total count
    const topNums: { num: number; count: number }[] = [];
    for (let n = f * 10; n < f * 10 + 10; n++) {
      if (numCountAll[n]! > 0) topNums.push({ num: n, count: numCountAll[n]! });
    }
    topNums.sort((a, b) => b.count - a.count);

    families.push({
      family: f,
      label: `D${f} (${String(f * 10).padStart(2, "0")}-${String(f * 10 + 9).padStart(2, "0")})`,
      countAll: ca,
      countRecent: cr,
      freqAll: fa,
      freqRecent: fr,
      momentum,
      currentGapDays,
      avgGapDays,
      dueFactor,
      lastDateStr,
      topNums: topNums.slice(0, 5),
    });
  }

  return { families, latestDateStr };
}

function momentumLabel(m: number): string {
  if (m >= 2.0) return "↑↑↑";
  if (m >= 1.5) return "↑↑ ";
  if (m >= 1.0) return "↑  ";
  if (m === 0) return "—  ";
  return "↓  ";
}

function dueIcon(f: number): string {
  return f >= 2.0 ? "🔴" : f >= 1.5 ? "🟠" : f >= 1.0 ? "🟡" : "  ";
}

function formatMessage(
  { families, latestDateStr }: ReturnType<typeof computeDecadeFamilies>,
  mapSource: "p3" | "p4",
  period: "m" | "e",
  rangeStr: string
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  // Sort by momentum desc for top, by dueFactor desc for due
  const byMomentum = [...families].sort((a, b) => b.momentum - a.momentum);
  const byDue = [...families]
    .filter((f) => f.dueFactor > 0)
    .sort((a, b) => b.dueFactor - a.dueFactor);

  const lines: string[] = [
    `📊 *Familias de Decenas* — ${mapLabel} · ${periodLabel}`,
    `Período: ${rangeStr} · Último registro: ${latestDateStr}`,
    "",
    "📖 _Qué mide:_ agrupa los 100 números en 10 familias \\(D0\\=00\\-09, D1\\=10\\-19, …\\)\\.",
    "_Momento_ = frecuencia reciente ÷ histórica \\(↑↑↑ en alza fuerte\\)\\.",
    "_Due_ = brecha actual ÷ promedio\\. Primero identifica la familia, luego sus candidatos internos\\.",
    "",
    "```",
    "RANKING POR MOMENTUM (familias más activas recientemente)",
    "Familia    Rec%    Hist%   Moment.  Due      Últ.Vez",
    "──────────────────────────────────────────────────────",
  ];

  for (const f of byMomentum) {
    const rec = `${(f.freqRecent * 100).toFixed(1)}%`.padStart(6);
    const hist = `${(f.freqAll * 100).toFixed(1)}%`.padStart(6);
    const mom = f.momentum >= 10 ? " nuevo↑" : `${f.momentum.toFixed(1)}x`.padStart(6);
    const ml = momentumLabel(f.momentum);
    const due = f.avgGapDays > 0 ? `${f.dueFactor.toFixed(1)}x` : "  — ";
    lines.push(`${f.label.padEnd(11)} ${rec}  ${hist}  ${mom} ${ml}  ${due.padStart(5)}  ${f.lastDateStr}`);
  }

  lines.push("");
  lines.push("TOP CANDIDATOS INTERNOS (familias con momentum ≥ 1.0)");

  const hotFamilies = byMomentum.filter((f) => f.momentum >= 1.0 && f.countAll > 0).slice(0, 4);

  if (hotFamilies.length === 0) {
    lines.push("  Sin familias con momentum suficiente en este período.");
  } else {
    for (const f of hotFamilies) {
      const momStr = f.momentum >= 10 ? "nuevo↑" : `${f.momentum.toFixed(1)}x`;
      lines.push(`  ${f.label} [${momStr}]: ${f.topNums.map((x) => `${String(x.num).padStart(2, "0")}(${x.count}x)`).join("  ")}`);
    }
  }

  lines.push("");
  lines.push("FAMILIAS MÁS DEBIDAS (mayor brecha actual)");
  lines.push("Familia     Due     DíasSin  AvgGap  Últ.Vez");
  lines.push("──────────────────────────────────────────────");

  for (const f of byDue.slice(0, 5)) {
    const due = `${f.dueFactor.toFixed(1)}x`.padStart(5);
    const cur = `${f.currentGapDays}d`.padStart(7);
    const avg = `${f.avgGapDays.toFixed(1)}d`.padStart(6);
    lines.push(`${f.label.padEnd(12)}${due}  ${cur}  ${avg}  ${f.lastDateStr} ${dueIcon(f.dueFactor)}`);
  }

  lines.push("");
  lines.push("🔴≥2x · 🟠≥1.5x · 🟡≥1x = familia debida · ↑↑↑≥2x momentum fuerte");
  lines.push("```");

  return truncateMsg(lines.join("\n").trimEnd());
}

export const decadeFamily: StrategyDefinition = {
  id: "decade_family",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,

  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const result = computeDecadeFamilies(map, context.period, context.mapSource);
    const rangeStr = getDateRangeStr(map, context.period, context.mapSource);
    return formatMessage(result, context.mapSource, context.period, rangeStr);
  },

  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const { families } = computeDecadeFamilies(map, context.period, context.mapSource);

    // Combine: hot families (momentum≥1) get their top nums first, then due families
    const byMomentum = [...families]
      .filter((f) => f.momentum >= 1.0 && f.countAll > 0)
      .sort((a, b) => b.momentum - a.momentum)
      .slice(0, 4);

    const byDue = [...families]
      .filter((f) => f.dueFactor >= 1.0 && f.countAll > 0)
      .sort((a, b) => b.dueFactor - a.dueFactor)
      .slice(0, 3);

    const seen = new Set<number>();
    const result: number[] = [];

    for (const f of [...byMomentum, ...byDue]) {
      for (const x of f.topNums) {
        if (!seen.has(x.num)) { seen.add(x.num); result.push(x.num); }
      }
    }
    return result.slice(0, 20);
  },
};
