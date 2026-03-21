/**
 * Estrategia — Resonancia Temporal Fibonacci PLUS (UnoDosTres+)
 *
 * Variante de UnoDosTres con selección dinámica de candidatos (por input de texto)
 * y soporte para período combinado (Ambos). 
 * IMPORTANTE: El motor matemático y formato es 100% independiente de unodostres.ts
 *
 * Id: unodostres_plus
 */

import { InlineKeyboard } from "grammy";
import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { STRATEGY_CONTEXT_CALLBACK_PREFIX } from "./types.js";
import {
  twoDigitNumbers,
  truncateMsg,
  sortDateKeys,
  getDateRangeStr,
  mmddyyToDate,
} from "./utils.js";

// ── Parámetros del modelo ────────────────────────────────────────────────────

const FIBONACCI: readonly number[] = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144];
const F_MAX    = 144;
const SIGMA    = 3.5;
const ALPHA    = 0.40;
const BETA     = 0.20;

type FibPhase = "early" | "expansion" | "major" | "none";

interface FibStat {
  num:           number;
  appearances:   number;
  lastSeenDate:  string | null;
  daysSinceLast: number;
  fibScore:      number;
  nearestFib:    number;
  phase:         FibPhase;
  finalScore:    number;
}

// ── Funciones matemáticas aisladas ───────────────────────────────────────────

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

function nearestFib(n: number): number {
  let best   = FIBONACCI[0]!;
  let minDist = Math.abs(n - best);
  for (const f of FIBONACCI) {
    const dist = Math.abs(n - f);
    if (dist < minDist) { minDist = dist; best = f; }
  }
  return best;
}

function computePhase(daysSinceLast: number): FibPhase {
  const nf   = nearestFib(daysSinceLast);
  const dist = Math.abs(daysSinceLast - nf);
  if (dist > SIGMA * 2) return "none";
  if (nf <= 5)  return "early";
  if (nf <= 21) return "expansion";
  return "major";
}

// ── Motor de cómputo (con soporte período "a") ───────────────────────────────

function computeFibStats(
  map: DateDrawsMap,
  period: "m" | "e",
  ambos: boolean,
  mapSource: "p3" | "p4"
): { stats: FibStat[]; totalDraws: number; rangeFrom: string; rangeTo: string } {
  const minLen = mapSource === "p4" ? 4 : 3;

  // Filtrar fechas que contengan al menos un sorteo válido para el período solicitado
  const validSet = new Set<string>();
  for (const [d, draws] of Object.entries(map)) {
    if ((period === "m" || ambos) && draws.m && draws.m.length >= minLen) validSet.add(d);
    if ((period === "e" || ambos) && draws.e && draws.e.length >= minLen) validSet.add(d);
  }
  
  const allDates = sortDateKeys(Array.from(validSet));
  
  if (allDates.length === 0) {
    const empty: FibStat[] = Array.from({ length: 100 }, (_, n) => ({
      num: n, appearances: 0, lastSeenDate: null,
      daysSinceLast: 9999, fibScore: 0, nearestFib: 0,
      phase: "none" as FibPhase, finalScore: 0.1,
    }));
    return { stats: empty, totalDraws: 0, rangeFrom: "Sin datos", rangeTo: "Sin datos" };
  }

  const latestDateStr = allDates[allDates.length - 1]!;
  const latestDate    = mmddyyToDate(latestDateStr);

  const lastSeen    = new Map<number, string>();
  const appearances = new Map<number, number>();
  for (let n = 0; n < 100; n++) appearances.set(n, 0);

  let totalDraws = 0;

  for (const dateStr of allDates) {
    const draws = map[dateStr];
    if (!draws) continue;

    if (period === "m" || ambos) {
      const drawM = draws.m;
      if (drawM && drawM.length >= minLen) {
        totalDraws++;
        for (const num of twoDigitNumbers(drawM, mapSource)) {
          if (num >= 0 && num <= 99) {
            lastSeen.set(num, dateStr);
            appearances.set(num, (appearances.get(num) ?? 0) + 1);
          }
        }
      }
    }
    
    if (period === "e" || ambos) {
      const drawE = draws.e;
      if (drawE && drawE.length >= minLen) {
        totalDraws++;
        for (const num of twoDigitNumbers(drawE, mapSource)) {
          if (num >= 0 && num <= 99) {
            lastSeen.set(num, dateStr);
            appearances.set(num, (appearances.get(num) ?? 0) + 1);
          }
        }
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
    const count   = appearances.get(n) ?? 0;
    const lastStr = lastSeen.get(n) ?? null;

    let daysSinceLast = 9999;
    if (lastStr && latestDate) {
      const lastDate = mmddyyToDate(lastStr);
      if (lastDate) {
        const diffMs = latestDate.getTime() - lastDate.getTime();
        daysSinceLast = Math.round(diffMs / (1000 * 60 * 60 * 24));
      }
    }

    const fScore    = count > 0 ? fibResonance(daysSinceLast) : 0;
    const histNorm  = count / maxAppear;
    const finalScore = 0.1 + ALPHA * fScore + BETA * histNorm;

    stats.push({
      num: n, appearances: count, lastSeenDate: lastStr,
      daysSinceLast,
      fibScore: fScore,
      nearestFib: count > 0 ? nearestFib(daysSinceLast) : 0,
      phase: count > 0 ? computePhase(daysSinceLast) : "none",
      finalScore,
    });
  }

  return { stats, totalDraws, rangeFrom: allDates[0]!, rangeTo: allDates[allDates.length - 1]! };
}

// ── Formato de salida (Idéntico a unodostres) ───────────────────────────────

function phaseIcon(phase: FibPhase): string {
  switch (phase) {
    case "major":     return "🔴";
    case "expansion": return "🟡";
    case "early":     return "🟢";
    default:          return "  ";
  }
}

function formatMessage(
  { stats, totalDraws, rangeFrom, rangeTo }: ReturnType<typeof computeFibStats>,
  mapSource: "p3" | "p4",
  period: "m" | "e",
  ambos: boolean,
  limit: number
): string {
  const periodLabel = ambos ? "🌗 Ambos" : period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel    = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";
  const rangeStr    = rangeFrom === rangeTo ? rangeFrom : `${rangeFrom} – ${rangeTo}`;

  const inResonance = stats
    .filter((s) => s.appearances > 0 && s.phase !== "none")
    .sort((a, b) => b.finalScore - a.finalScore);

  const topN = inResonance.slice(0, limit);
  const majorPhase     = topN.filter((s) => s.phase === "major");
  const expansionPhase = topN.filter((s) => s.phase === "expansion");
  const earlyPhase     = topN.filter((s) => s.phase === "early");

  const lines: string[] = [
    `✨ *UNODOSTRES+* — ${mapLabel} · ${periodLabel}`,
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
    const rowHeader = "Num  Días   F_cerca ";
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
        lines.push(`${n}   ${d}   ${fn}   ${phaseIcon(s.phase)}`);
      }
      lines.push("");
    };

    addSection("🔴 CICLO MAYOR (F34-F144 — resonancia pico):", majorPhase);
    addSection("🟡 EXPANSIÓN (F8-F21 — resonancia alta):", expansionPhase);
    addSection("🟢 CORTO PLAZO (F1-F5 — resonancia inicial):", earlyPhase);
  }

  lines.push(`En resonancia activa: ${inResonance.length}/100 números`);
  lines.push("🔴 Ciclo Mayor · 🟡 Expansión · 🟢 Corto Plazo");
  lines.push("```");

  return truncateMsg(lines.join("\n").trimEnd());
}

// ── Teclado contextual ────────────────────────────────────────────────────────

function buildPlusContextKeyboard(menuId: string): InlineKeyboard {
  const pre = `${STRATEGY_CONTEXT_CALLBACK_PREFIX}${menuId}_`;
  return new InlineKeyboard()
    .text("P3 ☀️ Medio", `${pre}p3_m`)
    .text("P3 🌙 Noche", `${pre}p3_e`)
    .text("P3 🌗 Ambos", `${pre}p3_a`)
    .row()
    .text("P4 ☀️ Medio", `${pre}p4_m`)
    .text("P4 🌙 Noche", `${pre}p4_e`)
    .text("P4 🌗 Ambos", `${pre}p4_a`)
    .row()
    .text("◀️ Volver", "volver");
}

function getPlusContextMessage(menuLabel: string, description?: string): string {
  const desc = description ? `_${description}_\n\n` : "";
  return (
    `✨ *${menuLabel}*\n\n${desc}` +
    `Selecciona una base de datos y un periodo. A continuación el sistema te solicitará escribir la cantidad de resultados deseados.`
  );
}

// ── Definición de la estrategia ───────────────────────────────────────────────

export const unodostresPlus: StrategyDefinition = {
  id: "unodostres_plus",
  description:
    "Resonancia Fibonacci mejorada, permite configuración dinámica de candidatos mediante chat y combinar M/E unificados.",
  getContextMessage: getPlusContextMessage,
  buildContextKeyboard: buildPlusContextKeyboard,

  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const limit  = typeof context.params?.limit === "number" ? context.params.limit : 20; // Default 20 igual que original
    const ambos  = !!context.params?.ambos;
    const result = computeFibStats(map, context.period, ambos, context.mapSource);
    return formatMessage(result, context.mapSource, context.period, ambos, limit);
  },

  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const limit  = typeof context.params?.limit === "number" ? context.params.limit : 20;
    const ambos  = !!context.params?.ambos;
    const { stats } = computeFibStats(map, context.period, ambos, context.mapSource);
    return stats
      .filter((s) => s.appearances > 0 && s.fibScore > 0.01)
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, limit)
      .map((s) => s.num);
  },
};
