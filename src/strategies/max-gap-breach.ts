/**
 * Estrategia — Ruptura de Récord de Ausencia
 *
 * Identifica números donde la brecha actual (días sin salir) supera la brecha
 * MÁXIMA histórica registrada — es decir, nunca en toda la historia disponible
 * habían pasado tantos días sin aparecer.
 *
 * A diferencia de gap_due (que compara la brecha actual con el PROMEDIO),
 * este análisis usa el MÁXIMO histórico como umbral. Cuando un número rompe
 * su récord de ausencia, entra en territorio estadístico sin precedentes y la
 * presión para aparecer es máxima bajo cualquier hipótesis de distribución uniforme.
 *
 *   exceso = brecha_actual − brecha_máxima_histórica
 *   Si exceso > 0 → rompió su récord: candidato de máxima urgencia.
 *   Si exceso < 0 → aún no llega a su peor ausencia histórica.
 *
 * Complementa a gap_due: gap_due detecta números "atrasados vs promedio";
 * max_gap_breach detecta los que superan su récord absoluto.
 *
 * Id: max_gap_breach
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

interface BreachStat {
  num: number;
  appearances: number;
  currentGap: number;
  maxHistGap: number;
  avgGap: number;
  excess: number;
  pctOfRecord: number;
  lastDateStr: string;
}

function computeBreaches(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): { stats: BreachStat[]; latestDateStr: string } {
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

  const stats: BreachStat[] = [];

  for (let n = 0; n < 100; n++) {
    const dates = appearances.get(n)!.sort((a, b) => a.getTime() - b.getTime());

    if (dates.length < 2) {
      stats.push({
        num: n,
        appearances: dates.length,
        currentGap: dates.length === 1
          ? Math.floor((today.getTime() - dates[0]!.getTime()) / 86_400_000)
          : 9999,
        maxHistGap: 0,
        avgGap: 0,
        excess: 0,
        pctOfRecord: 0,
        lastDateStr: dates.length === 1
          ? (() => {
              const d = dates[0]!;
              return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${String(d.getFullYear()).slice(-2)}`;
            })()
          : "N/A",
      });
      continue;
    }

    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(Math.floor((dates[i]!.getTime() - dates[i - 1]!.getTime()) / 86_400_000));
    }

    const maxHistGap = Math.max(...gaps);
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const lastDate = dates.at(-1)!;
    const currentGap = Math.floor((today.getTime() - lastDate.getTime()) / 86_400_000);
    const excess = currentGap - maxHistGap;
    const pctOfRecord = maxHistGap > 0 ? (currentGap / maxHistGap) * 100 : 0;

    const mm = String(lastDate.getMonth() + 1).padStart(2, "0");
    const dd = String(lastDate.getDate()).padStart(2, "0");
    const yy = String(lastDate.getFullYear()).slice(-2);

    stats.push({
      num: n,
      appearances: dates.length,
      currentGap,
      maxHistGap,
      avgGap,
      excess,
      pctOfRecord,
      lastDateStr: `${mm}/${dd}/${yy}`,
    });
  }

  return { stats, latestDateStr };
}

function formatMessage(
  { stats, latestDateStr }: ReturnType<typeof computeBreaches>,
  mapSource: "p3" | "p4",
  period: "m" | "e",
  rangeStr: string
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  // Numbers that broke their record (excess > 0)
  const breached = stats
    .filter((s) => s.appearances >= 3 && s.excess > 0)
    .sort((a, b) => b.excess - a.excess)
    .slice(0, 15);

  // Numbers approaching their record (80%+)
  const approaching = stats
    .filter((s) => s.appearances >= 3 && s.excess <= 0 && s.pctOfRecord >= 80)
    .sort((a, b) => b.pctOfRecord - a.pctOfRecord)
    .slice(0, 10);

  const icon = (excess: number) =>
    excess > 30 ? "🔴🔴" : excess > 15 ? "🔴" : excess > 5 ? "🟠" : "🟡";

  const lines: string[] = [
    `📊 *Ruptura de Récord de Ausencia* — ${mapLabel} · ${periodLabel}`,
    `Período: ${rangeStr} · Último registro: ${latestDateStr}`,
    "",
    "📖 _Qué mide:_ números cuya brecha actual supera su MÁXIMO histórico de ausencia\\.",
    "_Exceso_ = días actuales sin salir − récord histórico máximo\\. Si >0 → territorio sin precedentes\\.",
    "_Pct_ = brecha actual ÷ récord máximo × 100\\. ≥100% = récord roto\\. Complementa a Gap Debidos\\.",
    "",
    "```",
  ];

  if (breached.length === 0) {
    lines.push("✅ Ningún número ha roto su récord de ausencia actualmente.");
    lines.push("");
  } else {
    lines.push(`🚨 RÉCORD ROTO (${breached.length} números en territorio sin precedentes)`);
    lines.push("Num  Actual  Máx.Hist  Exceso  Pct%  Últ.Vez");
    lines.push("────────────────────────────────────────────────");
    for (const s of breached) {
      const n = String(s.num).padStart(2, "0");
      const cur = String(s.currentGap).padStart(5) + "d";
      const mxh = String(s.maxHistGap).padStart(7) + "d";
      const exc = `+${s.excess}d`.padStart(7);
      const pct = `${s.pctOfRecord.toFixed(0)}%`.padStart(5);
      const lv = s.lastDateStr;
      lines.push(`${n}   ${cur}  ${mxh}  ${exc}  ${pct}  ${lv} ${icon(s.excess)}`);
    }
    lines.push("");
  }

  if (approaching.length > 0) {
    lines.push("⚠️ ACERCÁNDOSE AL RÉCORD (≥80% del máximo histórico)");
    lines.push("Num  Actual  Máx.Hist  Pct%  Últ.Vez");
    lines.push("─────────────────────────────────────────");
    for (const s of approaching) {
      const n = String(s.num).padStart(2, "0");
      const cur = String(s.currentGap).padStart(5) + "d";
      const mxh = String(s.maxHistGap).padStart(7) + "d";
      const pct = `${s.pctOfRecord.toFixed(0)}%`.padStart(5);
      const lv = s.lastDateStr;
      lines.push(`${n}   ${cur}  ${mxh}  ${pct}  ${lv}`);
    }
    lines.push("");
  }

  lines.push("🔴🔴 +30d extra · 🔴 +15d · 🟠 +5d · 🟡 roto reciente");
  lines.push("```");
  return truncateMsg(lines.join("\n").trimEnd());
}

export const maxGapBreach: StrategyDefinition = {
  id: "max_gap_breach",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,

  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const result = computeBreaches(map, context.period, context.mapSource);
    const rangeStr = getDateRangeStr(map, context.period, context.mapSource);
    return formatMessage(result, context.mapSource, context.period, rangeStr);
  },

  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const { stats } = computeBreaches(map, context.period, context.mapSource);
    // Priority: breached first (by excess), then approaching (by pct)
    const breached = stats
      .filter((s) => s.appearances >= 3 && s.excess > 0)
      .sort((a, b) => b.excess - a.excess)
      .slice(0, 12)
      .map((s) => s.num);

    const approaching = stats
      .filter((s) => s.appearances >= 3 && s.excess <= 0 && s.pctOfRecord >= 80)
      .sort((a, b) => b.pctOfRecord - a.pctOfRecord)
      .slice(0, 8)
      .map((s) => s.num);

    const seen = new Set<number>();
    const result: number[] = [];
    for (const n of [...breached, ...approaching]) {
      if (!seen.has(n)) { seen.add(n); result.push(n); }
    }
    return result.slice(0, 20);
  },
};
