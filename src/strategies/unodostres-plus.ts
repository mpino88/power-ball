/**
 * Estrategia — Resonancia Temporal Fibonacci PLUS (UnoDosTres+)
 *
 * Variante de UnoDosTres con selección dinámica de candidatos (10/20/30)
 * y output visual simplificado. El motor matemático es 100% idéntico.
 *
 * Formato de salida: agrupado por fase (🔴/🟡/🟢) con columnas limpias.
 * Sin datos técnicos crudos expuestos al usuario.
 *
 * Id: unodostres_plus
 */

import { InlineKeyboard } from "grammy";
import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { STRATEGY_CONTEXT_CALLBACK_PREFIX } from "./types.js";
import {
  twoDigitNumbers,
  truncateMsg,
  validDateKeys,
  getDateRangeStr,
  mmddyyToDate,
} from "./utils.js";

// ── Parámetros del modelo (IDÉNTICOS a unodostres) ───────────────────────────

const FIBONACCI: readonly number[] = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144];
const F_MAX    = 144;
const SIGMA    = 3.5;
const ALPHA    = 0.40;
const BETA     = 0.20;

// ── Tipos ────────────────────────────────────────────────────────────────────

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

// ── Funciones matemáticas (IDÉNTICAS a unodostres) ───────────────────────────

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

// ── Motor de cómputo (IDÉNTICO a unodostres) ─────────────────────────────────

function computeFibStats(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): { stats: FibStat[]; totalDraws: number } {
  const minLen   = mapSource === "p4" ? 4 : 3;
  const allDates = validDateKeys(map, period, mapSource);
  const totalDraws = allDates.length;

  if (totalDraws === 0) {
    const empty: FibStat[] = Array.from({ length: 100 }, (_, n) => ({
      num: n, appearances: 0, lastSeenDate: null,
      daysSinceLast: 9999, fibScore: 0, nearestFib: 0,
      phase: "none" as FibPhase, finalScore: 0.1,
    }));
    return { stats: empty, totalDraws: 0 };
  }

  const latestDateStr = allDates[allDates.length - 1]!;
  const latestDate    = mmddyyToDate(latestDateStr);

  const lastSeen    = new Map<number, string>();
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

  let maxAppear = 1;
  for (const c of appearances.values()) { if (c > maxAppear) maxAppear = c; }

  const stats: FibStat[] = [];
  for (let n = 0; n < 100; n++) {
    const count   = appearances.get(n) ?? 0;
    const lastStr = lastSeen.get(n) ?? null;

    let daysSinceLast = 9999;
    if (lastStr && latestDate) {
      const lastDate = mmddyyToDate(lastStr);
      if (lastDate) {
        daysSinceLast = Math.round(
          (latestDate.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)
        );
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

  return { stats, totalDraws };
}

// ── Formato de salida simplificado (NUEVO en Plus) ────────────────────────────

function formatMessage(
  { stats, totalDraws }: ReturnType<typeof computeFibStats>,
  mapSource: "p3" | "p4",
  period: "m" | "e",
  rangeStr: string,
  limit: number
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel    = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  const inResonance = stats
    .filter((s) => s.appearances > 0 && s.phase !== "none")
    .sort((a, b) => b.finalScore - a.finalScore);

  const majorPhase     = inResonance.filter((s) => s.phase === "major");
  const expansionPhase = inResonance.filter((s) => s.phase === "expansion");
  const earlyPhase     = inResonance.filter((s) => s.phase === "early");

  // Calcular cuántos mostrar por sección manteniendo proporción del top-limit global
  const topN = inResonance.slice(0, limit);
  const nMajor = Math.min(majorPhase.length, topN.filter(s => s.phase === "major").length);
  const nExpansion = Math.min(expansionPhase.length, topN.filter(s => s.phase === "expansion").length);
  const nEarly = Math.min(earlyPhase.length, topN.filter(s => s.phase === "early").length);

  const SEP = "──────────────────────────────────────";
  const HDR = "Num  Días   F_cerca ";

  const rowLine = (s: FibStat) => {
    const n  = String(s.num).padStart(2, "0");
    const d  = `${s.daysSinceLast}d`.padStart(5);
    const fn = `F${s.nearestFib}`.padStart(7);
    return `${n}   ${d}   ${fn}`;
  };

  const addSection = (icon: string, label: string, list: FibStat[], max: number): string[] => {
    if (list.length === 0 || max === 0) return [];
    const rows = list.slice(0, max).map(rowLine);
    return [`${icon} ${label}`, HDR, SEP, ...rows, ""];
  };

  const lines: string[] = [
    `✨ *UNODOSTRES+* — ${mapLabel} · ${periodLabel}`,
    `Top ${limit} · Período: ${rangeStr} · ${totalDraws} sorteos`,
    "",
    "```",
  ];

  if (inResonance.length === 0) {
    lines.push("Sin candidatos en resonancia Fibonacci activa.");
    lines.push("");
  } else {
    lines.push(
      ...addSection("🔴", "CICLO MAYOR (F34-F144 — resonancia pico):", majorPhase, nMajor > 0 ? nMajor : Math.min(majorPhase.length, Math.ceil(limit * 0.4))),
      ...addSection("🟡", "EXPANSIÓN (F8-F21 — resonancia alta):", expansionPhase, nExpansion > 0 ? nExpansion : Math.min(expansionPhase.length, Math.ceil(limit * 0.4))),
      ...addSection("🟢", "CORTO PLAZO (F1-F5 — resonancia inicial):", earlyPhase, nEarly > 0 ? nEarly : Math.min(earlyPhase.length, limit)),
    );
  }

  lines.push(`En resonancia activa: ${inResonance.length}/100 números`);
  lines.push("Score = Puntaje final del 0 al 1 sumando el ciclo y las veces que ha salido.");
  lines.push("🔴 Ciclo Mayor · 🟡 Expansión · 🟢 Corto Plazo");
  lines.push("```");

  return truncateMsg(lines.join("\n").trimEnd());
}

// ── Teclado contextual con selección de cantidad ──────────────────────────────

function buildPlusContextKeyboard(menuId: string): InlineKeyboard {
  const pre = `${STRATEGY_CONTEXT_CALLBACK_PREFIX}${menuId}_`;
  return new InlineKeyboard()
    .text("P3 (Fijos) ☀️ Mediodía",  `${pre}p3_m_10`)
    .text("P3 (Fijos) 🌙 Noche",      `${pre}p3_e_10`)
    .row()
    .text("P4 (Corridos) ☀️ Mediodía", `${pre}p4_m_10`)
    .text("P4 (Corridos) 🌙 Noche",    `${pre}p4_e_10`)
    .row()
    .text("📋 Top 10",  `${pre}p3_m_10`)
    .text("📋 Top 20",  `${pre}p3_m_20`)
    .text("📋 Top 30",  `${pre}p3_m_30`)
    .row()
    .text("◀️ Volver", "volver");
}

function getPlusContextMessage(menuLabel: string, description?: string): string {
  const desc = description ? `_${description}_\n\n` : "";
  return (
    `✨ *${menuLabel}*\n\n${desc}` +
    `Elige *base de datos* y *período*.\n` +
    `Luego selecciona cuántos candidatos quieres ver:\n\n` +
    `• *P3 (Fijos)* → mapa Pick 3\n` +
    `• *P4 (Corridos)* → mapa Pick 4\n` +
    `• ☀️ Mediodía · 🌙 Noche\n\n` +
    `📋 *Top 10 / 20 / 30* números en resonancia activa.`
  );
}

// ── Definición de la estrategia ───────────────────────────────────────────────

export const unodostresPlus: StrategyDefinition = {
  id: "unodostres_plus",
  description:
    "Resonancia Fibonacci mejorada. Detecta números en su pico cíclico (1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144 días). Salida limpia ordenada por ciclo activo. Elige Top 10, 20 o 30.",
  getContextMessage: getPlusContextMessage,
  buildContextKeyboard: buildPlusContextKeyboard,

  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const limit    = typeof context.params?.limit === "number" ? context.params.limit : 10;
    const result   = computeFibStats(map, context.period, context.mapSource);
    const rangeStr = getDateRangeStr(map, context.period, context.mapSource);
    return formatMessage(result, context.mapSource, context.period, rangeStr, limit);
  },

  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const limit  = typeof context.params?.limit === "number" ? context.params.limit : 10;
    const { stats } = computeFibStats(map, context.period, context.mapSource);
    return stats
      .filter((s) => s.appearances > 0 && s.fibScore > 0.01)
      .sort((a, b) => b.finalScore - a.finalScore)
      .slice(0, limit)
      .map((s) => s.num);
  },
};
