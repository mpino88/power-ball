/**
 * Estrategia — Resonancia Temporal Fibonacci (UnoDosTres)
 *
 * Modelo de temporalización cíclica inspirado en análisis cuantitativo de ciclos.
 *
 * Premisa: si un número apareció en t₀, los momentos de mayor probabilidad teórica
 * de reaparición coinciden con los intervalos de la serie de Fibonacci:
 *   T_n = t₀ + F_n  (F = {1,2,3,5,8,13,21,34,55,89,144})
 *
 * Función de resonancia temporal (gaussiana ponderada):
 *   W(t) = Σ_n (F_n/F_max) · exp(−(t − F_n)² / (2σ²))
 *   donde t = días transcurridos desde la última aparición del número.
 *
 * Score final combinado:
 *   Score(X) = 0.1 + α·W(daysSinceLast) + β·(appearances/maxAppear)
 *   α = peso ciclo Fibonacci · β = peso memoria histórica
 *
 * Los candidatos con mayor score son números cuya última aparición fue exactamente
 * F_n días atrás: están en su ventana de resonancia óptima.
 *
 * Fases del ciclo:
 *   - Corto plazo  → F1–F5  (1, 2, 3, 5 días)
 *   - Expansión    → F8–F21 (8, 13, 21 días)
 *   - Ciclo mayor  → F34+   (34, 55, 89, 144 días)
 *
 * Id: unodostres
 */

import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";
import {
  twoDigitNumbers,
  truncateMsg,
  validDateKeys,
  getDateRangeStr,
  mmddyyToDate,
} from "./utils.js";

// ── Parámetros del modelo ────────────────────────────────────────────────────

/** Serie de Fibonacci usada como intervalos de resonancia (en días calendario). */
const FIBONACCI: readonly number[] = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144];

/** Valor máximo de la serie (para normalizar el peso relativo de cada intervalo). */
const F_MAX = 144;

/** Ancho de ventana Gaussiana en días (σ). Controla cuán "preciso" debe ser el timing. */
const SIGMA = 3.5;

/** Peso del componente de ciclo Fibonacci en el score final. */
const ALPHA = 0.40;

/** Peso del componente de frecuencia histórica normalizada en el score final. */
const BETA = 0.20;

// ── Tipos ────────────────────────────────────────────────────────────────────

type FibPhase = "early" | "expansion" | "major" | "none";

interface FibStat {
  num: number;
  appearances: number;
  lastSeenDate: string | null;
  daysSinceLast: number;
  fibScore: number;
  nearestFib: number;
  phase: FibPhase;
  finalScore: number;
}

// ── Funciones matemáticas del modelo ────────────────────────────────────────

/**
 * Calcula la resonancia Fibonacci W(t): suma de Gaussianas centradas en cada
 * intervalo F_n, ponderadas por su magnitud relativa (F_n / F_max).
 * Valores altos indican que `daysSinceLast` coincide con un intervalo de Fibonacci.
 */
function fibResonance(daysSinceLast: number): number {
  if (daysSinceLast <= 0) return 0;
  let w = 0;
  for (const fn of FIBONACCI) {
    const relWeight = fn / F_MAX;
    const d = daysSinceLast - fn;
    w += relWeight * Math.exp(-(d * d) / (2 * SIGMA * SIGMA));
  }
  return w;
}

/** Retorna el número de Fibonacci más cercano a n. */
function nearestFib(n: number): number {
  let best = FIBONACCI[0];
  let minDist = Math.abs(n - best);
  for (const f of FIBONACCI) {
    const dist = Math.abs(n - f);
    if (dist < minDist) {
      minDist = dist;
      best = f;
    }
  }
  return best;
}

/** Clasifica la fase del ciclo Fibonacci según el intervalo más cercano. */
function computePhase(daysSinceLast: number): FibPhase {
  const nf = nearestFib(daysSinceLast);
  const dist = Math.abs(daysSinceLast - nf);
  if (dist > SIGMA * 2) return "none";
  if (nf <= 5) return "early";
  if (nf <= 21) return "expansion";
  return "major";
}

// ── Motor de cómputo ─────────────────────────────────────────────────────────

function computeFibStats(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): { stats: FibStat[]; totalDraws: number } {
  const minLen = mapSource === "p4" ? 4 : 3;
  const allDates = validDateKeys(map, period, mapSource);
  const totalDraws = allDates.length;

  if (totalDraws === 0) {
    const empty: FibStat[] = Array.from({ length: 100 }, (_, n) => ({
      num: n,
      appearances: 0,
      lastSeenDate: null,
      daysSinceLast: 9999,
      fibScore: 0,
      nearestFib: 0,
      phase: "none" as FibPhase,
      finalScore: 0.1,
    }));
    return { stats: empty, totalDraws: 0 };
  }

  // Referencia temporal: la fecha más reciente con sorteo válido actúa como "hoy"
  const latestDateStr = allDates[allDates.length - 1]!;
  const latestDate = mmddyyToDate(latestDateStr);

  // Una sola pasada para acumular última aparición y conteo por número
  const lastSeen = new Map<number, string>();
  const appearances = new Map<number, number>();
  for (let n = 0; n < 100; n++) appearances.set(n, 0);

  for (const dateStr of allDates) {
    const draw = map[dateStr]?.[period];
    if (!draw || draw.length < minLen) continue;
    for (const num of twoDigitNumbers(draw, mapSource)) {
      if (num >= 0 && num <= 99) {
        lastSeen.set(num, dateStr);
        appearances.set(num, (appearances.get(num) ?? 0) + 1);
      }
    }
  }

  // Máxima frecuencia para normalización O(1)
  let maxAppear = 1;
  for (const c of appearances.values()) {
    if (c > maxAppear) maxAppear = c;
  }

  const stats: FibStat[] = [];

  for (let n = 0; n < 100; n++) {
    const count = appearances.get(n) ?? 0;
    const lastStr = lastSeen.get(n) ?? null;

    let daysSinceLast = 9999;
    if (lastStr && latestDate) {
      const lastDate = mmddyyToDate(lastStr);
      if (lastDate) {
        const diffMs = latestDate.getTime() - lastDate.getTime();
        daysSinceLast = Math.round(diffMs / (1000 * 60 * 60 * 24));
      }
    }

    const fScore = count > 0 ? fibResonance(daysSinceLast) : 0;
    const histNorm = count / maxAppear;
    const finalScore = 0.1 + ALPHA * fScore + BETA * histNorm;

    stats.push({
      num: n,
      appearances: count,
      lastSeenDate: lastStr,
      daysSinceLast,
      fibScore: fScore,
      nearestFib: count > 0 ? nearestFib(daysSinceLast) : 0,
      phase: count > 0 ? computePhase(daysSinceLast) : "none",
      finalScore,
    });
  }

  return { stats, totalDraws };
}

// ── Formato del mensaje ───────────────────────────────────────────────────────

function phaseIcon(phase: FibPhase): string {
  switch (phase) {
    case "major":     return "🔴";
    case "expansion": return "🟡";
    case "early":     return "🟢";
    default:          return "  ";
  }
}

function formatMessage(
  { stats, totalDraws }: ReturnType<typeof computeFibStats>,
  mapSource: "p3" | "p4",
  period: "m" | "e",
  rangeStr: string
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  const inResonance = stats
    .filter((s) => s.appearances > 0 && s.phase !== "none")
    .sort((a, b) => b.finalScore - a.finalScore);

  const majorPhase = inResonance.filter((s) => s.phase === "major").slice(0, 8);
  const expansionPhase = inResonance.filter((s) => s.phase === "expansion").slice(0, 8);
  const earlyPhase = inResonance.filter((s) => s.phase === "early").slice(0, 8);

  const lines: string[] = [
    `📊 *Resonancia Fibonacci (UnoDosTres)* — ${mapLabel} · ${periodLabel}`,
    `Período: ${rangeStr} · Total sorteos: ${totalDraws}`,
    "",
    "📖 _Modelo:_ usa los números mágicos de Fibonacci para calcular los mejores días en los que un número puede salir\\.",
    `Te avisa si han pasado exactamente 1, 2, 3, 5, 8, 13, 21, 34, 55, 89 o 144 días desde que salió\\.`,
    "",
    "```",
  ];

  if (inResonance.length === 0) {
    lines.push("Sin candidatos en resonancia Fibonacci activa.");
    lines.push("");
  } else {
    const rowHeader = "Num  Días   F_cerca  FibScore  Score";
    const rowSep    = "──────────────────────────────────────";

    const addSection = (label: string, list: FibStat[]): void => {
      if (list.length === 0) return;
      lines.push(label);
      lines.push(rowHeader);
      lines.push(rowSep);
      for (const s of list) {
        const n   = String(s.num).padStart(2, "0");
        const d   = `${s.daysSinceLast}d`.padStart(5);
        const fn  = `F${s.nearestFib}`.padStart(7);
        const fs  = s.fibScore.toFixed(3).padStart(8);
        const sc  = s.finalScore.toFixed(3).padStart(6);
        lines.push(`${n}   ${d}  ${fn}  ${fs} ${sc} ${phaseIcon(s.phase)}`);
      }
      lines.push("");
    };

    addSection(`🔴 CICLO MAYOR (F34-F144 — resonancia pico):`, majorPhase);
    addSection(`🟡 EXPANSIÓN (F8-F21 — resonancia alta):`, expansionPhase);
    addSection(`🟢 CORTO PLAZO (F1-F5 — resonancia inicial):`, earlyPhase);
  }

  lines.push(`En resonancia activa: ${inResonance.length}/100 números`);
  lines.push("Score = Puntaje final del 0 al 1 sumando el ciclo y las veces que ha salido.");
  lines.push("🔴 Ciclo Mayor · 🟡 Expansión · 🟢 Corto Plazo");
  lines.push("```");

  return truncateMsg(lines.join("\n").trimEnd());
}

// ── Definición de la estrategia ───────────────────────────────────────────────

export const unodostres: StrategyDefinition = {
  id: "unodostres",
  description:
    "Busca coincidencias con la secuencia mágica de Fibonacci (1, 2, 3, 5, 8, 13...). Te avisa cuando un número cumple exactamente esos días sin salir, que es cuando tiene un 'pico' de probabilidad de reventar.",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,

  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const result = computeFibStats(map, context.period, context.mapSource);
    const rangeStr = getDateRangeStr(map, context.period, context.mapSource);
    return formatMessage(result, context.mapSource, context.period, rangeStr);
  },

  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const { stats } = computeFibStats(map, context.period, context.mapSource);
    return stats
      .filter((s) => s.appearances > 0 && s.fibScore > 0.01)
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, 20)
      .map((s) => s.num);
  },
};
