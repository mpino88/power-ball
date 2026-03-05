/**
 * Estrategia — Análisis de Rachas (Streak Analysis)
 *
 * Analiza dos tipos de rachas en conteo de sorteos (no en días calendario):
 *
 *   • Racha Caliente (Hot Streak): cuántos sorteos seguidos ha aparecido un número.
 *     Un número con racha activa muestra inercia — si viene saliendo en sorteos
 *     consecutivos o muy frecuentes en ventana corta, puede continuar.
 *
 *   • Racha Fría (Cold Streak): cuántos sorteos consecutivos lleva SIN aparecer.
 *     Se compara con la racha fría máxima histórica para detectar si está en un
 *     período de ausencia excepcionalmente largo (similar a max_gap_breach pero
 *     en sorteos, no en días).
 *
 * Métricas adicionales:
 *   - Hot Score: apariciones en los últimos 7/14 sorteos normalizadas
 *   - Cold Score: racha_fría_actual ÷ racha_fría_promedio_histórica
 *   - Tendencia de la racha: ¿se está calentando o enfriando?
 *
 * Diferencia clave vs trend_momentum y gap_due:
 *   trend_momentum usa frecuencia en ventana de 30 sorteos vs historia.
 *   gap_due trabaja en días calendario entre apariciones.
 *   streak_analysis trabaja en conteo de sorteos y analiza CONTINUIDAD:
 *   un número puede tener momentum alto (30 sorteos) pero racha fría activa
 *   (no sale hace 10 sorteos seguidos) — streak lo detecta y diferencia.
 *
 * Id: streak_analysis
 */

import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";
import {
  twoDigitNumbers,
  truncateMsg,
  validDateKeys,
  getDateRangeStr,
} from "./utils.js";

interface StreakStat {
  num: number;
  appearances: number;
  /** Current consecutive draws where number appeared (hot streak) */
  currentHotStreak: number;
  maxHotStreak: number;
  /** Current consecutive draws where number did NOT appear (cold streak) */
  currentColdStreak: number;
  maxColdStreak: number;
  avgColdStreak: number;
  coldDueFactor: number;  // currentColdStreak / avgColdStreak
  /** Appearances in last 7 and 14 draws */
  last7: number;
  last14: number;
  last30: number;
  /** Is currently on a hot streak? */
  isHot: boolean;
}

function computeStreaks(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): { stats: StreakStat[]; totalDraws: number } {
  const minLen = mapSource === "p4" ? 4 : 3;
  const allDates = validDateKeys(map, period, mapSource);
  const totalDraws = allDates.length;

  // Build presence array: presence[drawIdx][num] = true/false
  // We'll track per-number the sequence of draws
  const numPresent = new Map<number, boolean[]>();
  for (let n = 0; n < 100; n++) numPresent.set(n, []);

  for (const dateStr of allDates) {
    const draw = map[dateStr]?.[period];
    const nums = new Set<number>();
    if (draw && draw.length >= minLen) {
      for (const num of twoDigitNumbers(draw, mapSource)) {
        if (num >= 0 && num <= 99) nums.add(num);
      }
    }
    for (let n = 0; n < 100; n++) {
      numPresent.get(n)!.push(nums.has(n));
    }
  }

  const stats: StreakStat[] = [];

  for (let n = 0; n < 100; n++) {
    const presence = numPresent.get(n)!;
    const appearances = presence.filter(Boolean).length;

    // Current hot streak (from end backwards while present)
    let currentHotStreak = 0;
    for (let i = presence.length - 1; i >= 0; i--) {
      if (presence[i]) currentHotStreak++;
      else break;
    }

    // Max hot streak
    let maxHotStreak = 0;
    let run = 0;
    for (const p of presence) {
      if (p) { run++; maxHotStreak = Math.max(maxHotStreak, run); }
      else run = 0;
    }

    // Current cold streak (from end backwards while absent)
    let currentColdStreak = 0;
    for (let i = presence.length - 1; i >= 0; i--) {
      if (!presence[i]) currentColdStreak++;
      else break;
    }

    // Max cold streak and all cold streaks (for average)
    let maxColdStreak = 0;
    const coldStreaks: number[] = [];
    let coldRun = 0;
    for (const p of presence) {
      if (!p) { coldRun++; maxColdStreak = Math.max(maxColdStreak, coldRun); }
      else {
        if (coldRun > 0) coldStreaks.push(coldRun);
        coldRun = 0;
      }
    }
    // Don't count the current cold streak as a "historical" sample
    const avgColdStreak = coldStreaks.length > 0
      ? coldStreaks.reduce((s, x) => s + x, 0) / coldStreaks.length
      : 0;
    const coldDueFactor = avgColdStreak > 0 ? currentColdStreak / avgColdStreak : 0;

    // Last 7, 14, 30 draws
    const last7 = presence.slice(-7).filter(Boolean).length;
    const last14 = presence.slice(-14).filter(Boolean).length;
    const last30 = presence.slice(-30).filter(Boolean).length;

    stats.push({
      num: n,
      appearances,
      currentHotStreak,
      maxHotStreak,
      currentColdStreak,
      maxColdStreak,
      avgColdStreak,
      coldDueFactor,
      last7,
      last14,
      last30,
      isHot: currentHotStreak >= 2,
    });
  }

  return { stats, totalDraws };
}

function formatMessage(
  { stats, totalDraws }: ReturnType<typeof computeStreaks>,
  mapSource: "p3" | "p4",
  period: "m" | "e",
  rangeStr: string
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  // Hot: sorted by last7 desc, then currentHotStreak desc
  const hot = [...stats]
    .filter((s) => s.appearances >= 3 && (s.isHot || s.last7 >= 2))
    .sort((a, b) => {
      const scoreA = a.currentHotStreak * 3 + a.last7 * 2 + a.last14;
      const scoreB = b.currentHotStreak * 3 + b.last7 * 2 + b.last14;
      return scoreB - scoreA;
    })
    .slice(0, 15);

  // Cold due: high coldDueFactor
  const coldDue = [...stats]
    .filter((s) => s.appearances >= 3 && s.coldDueFactor >= 1.5)
    .sort((a, b) => b.coldDueFactor - a.coldDueFactor)
    .slice(0, 12);

  const coldIcon = (f: number) => f >= 3.0 ? "🔴" : f >= 2.0 ? "🟠" : f >= 1.5 ? "🟡" : "";

  const lines: string[] = [
    `📊 *Análisis de Rachas* — ${mapLabel} · ${periodLabel}`,
    `Período: ${rangeStr} · Total sorteos: ${totalDraws}`,
    "",
    "📖 _Qué mide:_ continuidad de rachas calientes \\(salidas seguidas\\) y frías \\(ausencias\\)\\.",
    "_Racha caliente_ = sorteos consecutivos apareciendo\\. _Due_ = racha fría actual ÷ promedio histórico\\.",
    "Diferencia de trend\\_momentum: usa conteo de sorteos y analiza CONTINUIDAD de la racha\\.",
    "",
    "```",
    `🔥 TOP RACHAS CALIENTES (últ.7/14 · hot streak activa · Total sorteos: ${totalDraws})`,
    "Num  Racha  Máx   Últ7  Últ14  Últ30  Caliente",
    "────────────────────────────────────────────────────",
  ];

  if (hot.length === 0) {
    lines.push("  Ningún número con racha caliente significativa.");
    lines.push("");
  } else {
    for (const s of hot) {
      const n = String(s.num).padStart(2, "0");
      const hs = `${s.currentHotStreak}dr`.padStart(5);
      const mhs = `${s.maxHotStreak}dr`.padStart(4);
      const l7 = String(s.last7).padStart(4);
      const l14 = String(s.last14).padStart(5);
      const l30 = String(s.last30).padStart(5);
      const flag = s.currentHotStreak >= 3 ? "🔥🔥" : s.currentHotStreak >= 2 ? "🔥" : "  ";
      lines.push(`${n}   ${hs}  ${mhs}  ${l7}   ${l14}   ${l30}  ${flag}`);
    }
    lines.push("");
  }

  lines.push(`❄️ RACHAS FRÍAS ATRASADAS (due ≥ 1.5 — ${coldDue.length} números)`);
  lines.push("Num  FríaAct  FríaMax  FríaProm  Due");
  lines.push("──────────────────────────────────────────");

  if (coldDue.length === 0) {
    lines.push("  Ningún número con racha fría anómala.");
  } else {
    for (const s of coldDue) {
      const n = String(s.num).padStart(2, "0");
      const ca = `${s.currentColdStreak}dr`.padStart(6);
      const cm = `${s.maxColdStreak}dr`.padStart(6);
      const cp = `${s.avgColdStreak.toFixed(1)}dr`.padStart(7);
      const due = `${s.coldDueFactor.toFixed(1)}x`.padStart(5);
      lines.push(`${n}   ${ca}   ${cm}   ${cp}   ${due} ${coldIcon(s.coldDueFactor)}`);
    }
  }

  lines.push("");
  lines.push("🔥🔥 racha activa ≥3 · 🔥 racha 2 · 🔴≥3x cold due · 🟠≥2x · 🟡≥1.5x");
  lines.push("```");

  return truncateMsg(lines.join("\n").trimEnd());
}

export const streakAnalysis: StrategyDefinition = {
  id: "streak_analysis",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,

  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const result = computeStreaks(map, context.period, context.mapSource);
    const rangeStr = getDateRangeStr(map, context.period, context.mapSource);
    return formatMessage(result, context.mapSource, context.period, rangeStr);
  },

  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const { stats } = computeStreaks(map, context.period, context.mapSource);

    // Blend: hot streak candidates + cold due candidates
    const hotScore = (s: StreakStat) => s.currentHotStreak * 3 + s.last7 * 2 + s.last14;
    const hotNums = [...stats]
      .filter((s) => s.appearances >= 3 && (s.isHot || s.last7 >= 2))
      .sort((a, b) => hotScore(b) - hotScore(a))
      .slice(0, 12)
      .map((s) => s.num);

    const coldNums = [...stats]
      .filter((s) => s.appearances >= 3 && s.coldDueFactor >= 1.5)
      .sort((a, b) => b.coldDueFactor - a.coldDueFactor)
      .slice(0, 10)
      .map((s) => s.num);

    const seen = new Set<number>();
    const result: number[] = [];
    for (const n of [...hotNums, ...coldNums]) {
      if (!seen.has(n)) { seen.add(n); result.push(n); }
    }
    return result.slice(0, 20);
  },
};
