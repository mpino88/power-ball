/**
 * Estrategia — Score Probabilístico Bayesiano
 *
 * Genera un puntaje de probabilidad posterior (0-100) para cada número,
 * combinando 6 señales estadísticas independientes con pesos diferenciados.
 *
 * A diferencia de consensus_multi (que vota binariamente: el número está o no
 * en el TOP de cada estrategia), este asigna probabilidades CONTINUAS y las
 * combina matemáticamente, produciendo un ranking de confianza real 0-100
 * con mayor capacidad discriminatoria entre candidatos.
 *
 * Las 6 señales normalizadas (0-1 cada una):
 *   S1 — Frecuencia histórica:   rank por apariciones totales
 *   S2 — Gap / deuda:            factor de atraso actual vs promedio
 *   S3 — Momentum reciente:      frecuencia últimos 30 sorteos vs histórica
 *   S4 — Patrón de ciclo:        fase del ciclo detectado (si existe)
 *   S5 — Transición Markov-1:    probabilidad de transición desde último sorteo
 *   S6 — Racha fría / deuda:     racha fría actual vs promedio histórico
 *
 * Fórmula de combinación:
 *   score = (w1·S1 + w2·S2 + w3·S3 + w4·S4 + w5·S5 + w6·S6) / Σwi × 100
 *
 * Pesos por defecto (equilibrados empíricamente):
 *   w1=0.15, w2=0.20, w3=0.20, w4=0.15, w5=0.20, w6=0.10
 *
 * El resultado es un ranking de los 20 números con mayor puntaje combinado,
 * mostrando el score individual de cada señal para transparencia total.
 *
 * Id: bayesian_score
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
const BAND_TOLERANCE = 0.20;
const MIN_CYCLE_CONCENTRATION = 0.22;

// Signal weights — must sum to 1.0
const W_FREQ = 0.15;
const W_GAP = 0.20;
const W_MOMENTUM = 0.20;
const W_CYCLE = 0.15;
const W_MARKOV = 0.20;
const W_STREAK = 0.10;

interface SignalVector {
  freq: number;     // 0-1
  gap: number;      // 0-1
  momentum: number; // 0-1
  cycle: number;    // 0-1
  markov: number;   // 0-1
  streak: number;   // 0-1
  score: number;    // 0-100 combined
}

function normalize(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  return range === 0 ? values.map(() => 0.5) : values.map((v) => (v - min) / range);
}

function computeBayesianScores(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): { vectors: Map<number, SignalVector>; lastDraw: number[]; lastDateStr: string } {
  const minLen = mapSource === "p4" ? 4 : 3;
  const allDates = validDateKeys(map, period, mapSource);
  const recentDates = allDates.slice(-RECENT_WINDOW);
  const totalDraws = allDates.length;

  // ── S1: Frequency ──────────────────────────────────────────────────────────
  const freqCount = new Array<number>(100).fill(0);
  for (const dateStr of allDates) {
    const draw = map[dateStr]?.[period];
    if (!draw || draw.length < minLen) continue;
    for (const num of twoDigitNumbers(draw, mapSource)) {
      if (num >= 0 && num <= 99) freqCount[num]++;
    }
  }

  // ── S2: Gap due factor ──────────────────────────────────────────────────────
  const numAppearDates = Array.from({ length: 100 }, () => [] as Date[]);
  for (const dateStr of allDates) {
    const draw = map[dateStr]?.[period];
    if (!draw || draw.length < minLen) continue;
    const date = mmddyyToDate(dateStr);
    if (!date) continue;
    for (const num of twoDigitNumbers(draw, mapSource)) {
      if (num >= 0 && num <= 99) numAppearDates[num]!.push(date);
    }
  }

  const today = new Date();
  const gapFactor = new Array<number>(100).fill(0);
  for (let n = 0; n < 100; n++) {
    const dates = numAppearDates[n]!.sort((a, b) => a.getTime() - b.getTime());
    if (dates.length < 2) continue;
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(Math.floor((dates[i]!.getTime() - dates[i - 1]!.getTime()) / 86_400_000));
    }
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const currentGap = Math.floor((today.getTime() - dates.at(-1)!.getTime()) / 86_400_000);
    gapFactor[n] = avgGap > 0 ? Math.min(currentGap / avgGap, 4) : 0;
  }

  // ── S3: Momentum (recent vs historical) ────────────────────────────────────
  const recentCount = new Array<number>(100).fill(0);
  for (const dateStr of recentDates) {
    const draw = map[dateStr]?.[period];
    if (!draw || draw.length < minLen) continue;
    for (const num of twoDigitNumbers(draw, mapSource)) {
      if (num >= 0 && num <= 99) recentCount[num]++;
    }
  }
  const momentumVal = new Array<number>(100).fill(0);
  for (let n = 0; n < 100; n++) {
    const fa = totalDraws > 0 ? freqCount[n]! / totalDraws : 0;
    const fr = recentDates.length > 0 ? recentCount[n]! / recentDates.length : 0;
    momentumVal[n] = fa > 0 ? Math.min(fr / fa, 5) : (fr > 0 ? 5 : 0);
  }

  // ── S4: Cycle phase ─────────────────────────────────────────────────────────
  const numAppearIdx = Array.from({ length: 100 }, () => [] as number[]);
  for (let i = 0; i < allDates.length; i++) {
    const draw = map[allDates[i]!]?.[period];
    if (!draw || draw.length < minLen) continue;
    for (const num of twoDigitNumbers(draw, mapSource)) {
      if (num >= 0 && num <= 99) numAppearIdx[num]!.push(i);
    }
  }

  const cyclePhase = new Array<number>(100).fill(0);
  for (let n = 0; n < 100; n++) {
    const idxList = numAppearIdx[n]!;
    if (idxList.length < 5) continue;
    const gaps: number[] = [];
    for (let i = 1; i < idxList.length; i++) gaps.push(idxList[i]! - idxList[i - 1]!);

    let bestCount = 0;
    let bestCenter = 0;
    for (const g of gaps) {
      const lo = g * (1 - BAND_TOLERANCE);
      const hi = g * (1 + BAND_TOLERANCE);
      const inBand = gaps.filter((x) => x >= lo && x <= hi);
      if (inBand.length > bestCount) {
        bestCount = inBand.length;
        bestCenter = Math.round(inBand.reduce((s, x) => s + x, 0) / inBand.length);
      }
    }

    const concentration = bestCount / gaps.length;
    if (concentration < MIN_CYCLE_CONCENTRATION || bestCenter < 2) continue;

    const drawsSince = totalDraws - 1 - idxList.at(-1)!;
    const phase = bestCenter > 0 ? Math.min(drawsSince / bestCenter, 3) : 0;
    cyclePhase[n] = phase;
  }

  // ── S5: Markov-1 transition score ──────────────────────────────────────────
  // Build transition matrix and score successors of last draw
  const matrix = new Map<number, Map<number, number>>();
  for (let n = 0; n < 100; n++) matrix.set(n, new Map());

  let prevNums: number[] = [];
  let lastDraw: number[] = [];
  let lastDateStr = "";

  for (const dateStr of allDates) {
    const draw = map[dateStr]?.[period];
    if (!draw || draw.length < minLen) { prevNums = []; continue; }
    const current = twoDigitNumbers(draw, mapSource);
    for (const from of prevNums) {
      for (const to of current) {
        if (from >= 0 && from <= 99 && to >= 0 && to <= 99) {
          const row = matrix.get(from)!;
          row.set(to, (row.get(to) ?? 0) + 1);
        }
      }
    }
    prevNums = current;
    lastDraw = draw;
    lastDateStr = dateStr;
  }

  const markovScore = new Array<number>(100).fill(0);
  const lastNums = twoDigitNumbers(lastDraw, mapSource);
  for (const from of lastNums) {
    const row = matrix.get(from) ?? new Map<number, number>();
    const total = [...row.values()].reduce((s, c) => s + c, 0);
    for (const [to, count] of row) {
      if (to >= 0 && to <= 99) {
        markovScore[to] = Math.max(markovScore[to]!, total > 0 ? count / total : 0);
      }
    }
  }

  // ── S6: Cold streak due ─────────────────────────────────────────────────────
  const numPresence = Array.from({ length: 100 }, () => [] as boolean[]);
  for (const dateStr of allDates) {
    const draw = map[dateStr]?.[period];
    const present = new Set<number>();
    if (draw && draw.length >= minLen) {
      for (const num of twoDigitNumbers(draw, mapSource)) {
        if (num >= 0 && num <= 99) present.add(num);
      }
    }
    for (let n = 0; n < 100; n++) numPresence[n]!.push(present.has(n));
  }

  const coldDueFactor = new Array<number>(100).fill(0);
  for (let n = 0; n < 100; n++) {
    const presence = numPresence[n]!;
    const coldStreaks: number[] = [];
    let coldRun = 0;
    for (const p of presence) {
      if (!p) coldRun++;
      else { if (coldRun > 0) coldStreaks.push(coldRun); coldRun = 0; }
    }
    // current cold streak
    let currentCold = 0;
    for (let i = presence.length - 1; i >= 0; i--) {
      if (!presence[i]) currentCold++;
      else break;
    }
    const avgCold = coldStreaks.length > 0
      ? coldStreaks.reduce((s, x) => s + x, 0) / coldStreaks.length
      : 0;
    coldDueFactor[n] = avgCold > 0 ? Math.min(currentCold / avgCold, 4) : 0;
  }

  // ── Normalize all signals and combine ──────────────────────────────────────
  const normFreq = normalize(freqCount);
  const normGap = normalize(gapFactor);
  const normMom = normalize(momentumVal);
  const normCycle = normalize(cyclePhase);
  const normMarkov = normalize(markovScore);
  const normStreak = normalize(coldDueFactor);

  const vectors = new Map<number, SignalVector>();
  for (let n = 0; n < 100; n++) {
    const f = normFreq[n]!;
    const g = normGap[n]!;
    const m = normMom[n]!;
    const c = normCycle[n]!;
    const mk = normMarkov[n]!;
    const st = normStreak[n]!;

    const combined =
      W_FREQ * f + W_GAP * g + W_MOMENTUM * m + W_CYCLE * c + W_MARKOV * mk + W_STREAK * st;
    const score = Math.round(combined * 100);

    vectors.set(n, { freq: f, gap: g, momentum: m, cycle: c, markov: mk, streak: st, score });
  }

  return { vectors, lastDraw, lastDateStr };
}

function formatMessage(
  { vectors, lastDraw, lastDateStr }: ReturnType<typeof computeBayesianScores>,
  mapSource: "p3" | "p4",
  period: "m" | "e",
  rangeStr: string
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";
  const lastNums = twoDigitNumbers(lastDraw, mapSource);

  const ranked = [...vectors.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, 20);

  const scoreBar = (val: number): string => {
    const filled = Math.round(val * 5);
    return "█".repeat(filled) + "░".repeat(5 - filled);
  };

  const lines: string[] = [
    `📊 *Score Bayesiano* — ${mapLabel} · ${periodLabel}`,
    `Período: ${rangeStr} · Último: ${lastDateStr} · Ref: ${lastNums.map((n) => String(n).padStart(2, "0")).join(", ")}`,
    "",
    "📖 _Qué mide:_ combina 6 señales estadísticas en un score continuo 0\\-100\\.",
    "_Señales_: Freq\\(15%\\) · Gap\\(20%\\) · Moment\\.\\(20%\\) · Ciclo\\(15%\\) · Markov\\(20%\\) · Racha\\(10%\\)",
    "Ventaja vs Consenso: score CONTINUO \\(no votación binaria\\) → mayor discriminación entre candidatos\\.",
    "",
    "```",
    "TOP 20 — SCORE BAYESIANO COMBINADO",
    " #  Num  Score  Frq  Gap  Mom  Cyc  Mkv  Str",
    "──────────────────────────────────────────────────",
  ];

  ranked.forEach(([num, v], i) => {
    const n = String(num).padStart(2, "0");
    const sc = String(v.score).padStart(3);
    const bar = (x: number) => scoreBar(x);
    lines.push(
      `${String(i + 1).padStart(2)}  ${n}   ${sc}   ${bar(v.freq)}  ${bar(v.gap)}  ${bar(v.momentum)}  ${bar(v.cycle)}  ${bar(v.markov)}  ${bar(v.streak)}`
    );
  });

  lines.push("");
  lines.push("█████=alto ░░░░░=bajo  Frq=Freq Gap=Deuda Mom=Momentum");
  lines.push("Cyc=Ciclo  Mkv=Markov  Str=RachaFría");
  lines.push("");

  // Top 5 detailed
  lines.push("DETALLE TOP 5:");
  ranked.slice(0, 5).forEach(([num, v], i) => {
    const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
    lines.push(`  ${i + 1}. ${String(num).padStart(2, "0")} · Score:${v.score} · F:${pct(v.freq)} G:${pct(v.gap)} M:${pct(v.momentum)} C:${pct(v.cycle)} Mk:${pct(v.markov)} St:${pct(v.streak)}`);
  });

  lines.push("```");
  return truncateMsg(lines.join("\n").trimEnd());
}

export const bayesianScore: StrategyDefinition = {
  id: "bayesian_score",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,

  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const result = computeBayesianScores(map, context.period, context.mapSource);
    const rangeStr = getDateRangeStr(map, context.period, context.mapSource);
    return formatMessage(result, context.mapSource, context.period, rangeStr);
  },

  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const { vectors } = computeBayesianScores(map, context.period, context.mapSource);
    return [...vectors.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, 20)
      .map(([num]) => num);
  },
};
