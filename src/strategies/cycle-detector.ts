/**
 * Estrategia — Detector de Ciclos y Periodicidad
 *
 * Detecta si un número tiene un ciclo de aparición predominante: ¿sale
 * aproximadamente cada 7 sorteos? ¿cada 14? ¿cada 21?
 *
 * Metodología:
 *   1. Para cada número, calcula todas las brechas entre apariciones consecutivas
 *      (inter-arrival gaps en número de sorteos, no en días).
 *   2. Agrupa las brechas en "bandas" de ±20% y busca la banda más frecuente.
 *   3. Si esa banda concentra ≥ 25% de todas las brechas, el número tiene un
 *      ciclo detectado. La moda de esa banda es la longitud del ciclo.
 *   4. Calcula la "fase del ciclo": sorteos_actuales_sin_salir ÷ ciclo_detectado.
 *      Fase ≈ 1.0 = justo en el punto del ciclo — máxima probabilidad de aparecer.
 *      Fase > 1.0 = ha sobrepasado el ciclo — presión creciente.
 *
 * Los números con ciclo detectado y fase cercana o mayor a 1.0 son los candidatos
 * más predecibles del sistema: su aparición es rítmica y el reloj dice que "toca".
 *
 * Complementa a gap_due (que trabaja en días) usando conteo de sorteos,
 * lo que elimina el ruido de los fines de semana y días sin sorteo.
 *
 * Id: cycle_detector
 */

import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";
import {
  twoDigitNumbers,
  truncateMsg,
  validDateKeys,
  getDateRangeStr,
} from "./utils.js";

const MIN_APPEARANCES = 5;
const BAND_TOLERANCE = 0.20; // ±20% to group gaps into the same band
const MIN_CYCLE_CONCENTRATION = 0.22; // at least 22% of gaps must fall in the dominant band

interface CycleStat {
  num: number;
  appearances: number;
  cycleLength: number;      // dominant cycle length in draws (0 = no cycle)
  cycleConcentration: number; // fraction of gaps in the dominant band
  drawsSinceLast: number;
  phase: number;            // drawsSinceLast / cycleLength (1.0 = due)
  hasCycle: boolean;
}

function computeCycles(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): { stats: CycleStat[]; totalDraws: number } {
  const minLen = mapSource === "p4" ? 4 : 3;
  const allDates = validDateKeys(map, period, mapSource);
  const totalDraws = allDates.length;

  // Build per-number draw-index appearance list
  const numAppearDrawIdx = new Map<number, number[]>();
  for (let n = 0; n < 100; n++) numAppearDrawIdx.set(n, []);

  for (let i = 0; i < allDates.length; i++) {
    const draw = map[allDates[i]!]?.[period];
    if (!draw || draw.length < minLen) continue;
    for (const num of twoDigitNumbers(draw, mapSource)) {
      if (num >= 0 && num <= 99) numAppearDrawIdx.get(num)!.push(i);
    }
  }

  const stats: CycleStat[] = [];

  for (let n = 0; n < 100; n++) {
    const idxList = numAppearDrawIdx.get(n)!;

    if (idxList.length < MIN_APPEARANCES) {
      const drawsSinceLast = idxList.length > 0 ? totalDraws - 1 - idxList.at(-1)! : 9999;
      stats.push({
        num: n,
        appearances: idxList.length,
        cycleLength: 0,
        cycleConcentration: 0,
        drawsSinceLast,
        phase: 0,
        hasCycle: false,
      });
      continue;
    }

    // Compute inter-arrival gaps
    const gaps: number[] = [];
    for (let i = 1; i < idxList.length; i++) {
      gaps.push(idxList[i]! - idxList[i - 1]!);
    }

    // Find dominant cycle: group by bands of ±20%
    let bestBandCenter = 0;
    let bestBandCount = 0;

    for (const g of gaps) {
      const lower = g * (1 - BAND_TOLERANCE);
      const upper = g * (1 + BAND_TOLERANCE);
      const inBand = gaps.filter((x) => x >= lower && x <= upper);
      if (inBand.length > bestBandCount) {
        bestBandCount = inBand.length;
        bestBandCenter = Math.round(inBand.reduce((s, x) => s + x, 0) / inBand.length);
      }
    }

    const concentration = bestBandCount / gaps.length;
    const hasCycle = concentration >= MIN_CYCLE_CONCENTRATION && bestBandCenter >= 2;
    const cycleLength = hasCycle ? bestBandCenter : 0;

    const drawsSinceLast = totalDraws - 1 - idxList.at(-1)!;
    const phase = cycleLength > 0 ? drawsSinceLast / cycleLength : 0;

    stats.push({
      num: n,
      appearances: idxList.length,
      cycleLength,
      cycleConcentration: concentration,
      drawsSinceLast,
      phase,
      hasCycle,
    });
  }

  return { stats, totalDraws };
}

function phaseIcon(phase: number): string {
  if (phase >= 1.2) return "🔴";
  if (phase >= 0.9) return "🟢";
  if (phase >= 0.7) return "🟡";
  return "  ";
}

function formatMessage(
  { stats, totalDraws }: ReturnType<typeof computeCycles>,
  mapSource: "p3" | "p4",
  period: "m" | "e",
  rangeStr: string
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  const withCycle = stats
    .filter((s) => s.hasCycle)
    .sort((a, b) => {
      // Sort by phase descending (those at or past their cycle first)
      return b.phase - a.phase;
    });

  const dueCycle = withCycle.filter((s) => s.phase >= 0.9).slice(0, 15);
  const upcomingCycle = withCycle.filter((s) => s.phase >= 0.6 && s.phase < 0.9).slice(0, 10);

  const lines: string[] = [
    `📊 *Detector de Ciclos* — ${mapLabel} · ${periodLabel}`,
    `Período: ${rangeStr} · Total sorteos analizados: ${totalDraws}`,
    "",
    "📖 _Qué mide:_ detecta si un número tiene un ciclo de aparición predominante\\.",
    "_Ciclo_ = intervalo \\(en sorteos\\) más frecuente entre apariciones del número\\.",
    "_Fase_ = sorteos sin salir ÷ ciclo\\. Fase ≈1\\.0 = el ciclo dice que toca ahora\\.",
    `_${withCycle.length} números_ tienen ciclo estadístico detectable \\(≥${(MIN_CYCLE_CONCENTRATION * 100).toFixed(0)}% de brechas en banda dominante\\)`,
    "",
    "```",
  ];

  if (dueCycle.length === 0) {
    lines.push("Ningún número con ciclo detectado está actualmente en fase de aparición.");
    lines.push("");
  } else {
    lines.push(`🟢 EN FASE (${dueCycle.length} números — fase ≥ 0.9 del ciclo):`);
    lines.push("Num  Ciclo  DrawsSin  Fase   Conc%  Aparic");
    lines.push("──────────────────────────────────────────────");
    for (const s of dueCycle) {
      const n = String(s.num).padStart(2, "0");
      const cyc = `${s.cycleLength}dr`.padStart(5);
      const ds = `${s.drawsSinceLast}dr`.padStart(7);
      const phase = `${s.phase.toFixed(2)}x`.padStart(6);
      const conc = `${(s.cycleConcentration * 100).toFixed(0)}%`.padStart(5);
      lines.push(`${n}   ${cyc}  ${ds}   ${phase}  ${conc}  ${s.appearances} ${phaseIcon(s.phase)}`);
    }
    lines.push("");
  }

  if (upcomingCycle.length > 0) {
    lines.push(`🟡 PRÓXIMAMENTE EN CICLO (${upcomingCycle.length} números — fase 0.6–0.9):`);
    lines.push("Num  Ciclo  DrawsSin  Fase   Conc%");
    lines.push("──────────────────────────────────────");
    for (const s of upcomingCycle) {
      const n = String(s.num).padStart(2, "0");
      const cyc = `${s.cycleLength}dr`.padStart(5);
      const ds = `${s.drawsSinceLast}dr`.padStart(7);
      const phase = `${s.phase.toFixed(2)}x`.padStart(6);
      const conc = `${(s.cycleConcentration * 100).toFixed(0)}%`.padStart(5);
      lines.push(`${n}   ${cyc}  ${ds}   ${phase}  ${conc}`);
    }
    lines.push("");
  }

  lines.push(`Total con ciclo detectado: ${withCycle.length}/100 números`);
  lines.push("🔴 Fase>1.2x (sobrepasó ciclo) · 🟢 0.9-1.2x (en ventana) · 🟡 0.6-0.9x (próximo)");
  lines.push("```");

  return truncateMsg(lines.join("\n").trimEnd());
}

export const cycleDetector: StrategyDefinition = {
  id: "cycle_detector",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,

  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const result = computeCycles(map, context.period, context.mapSource);
    const rangeStr = getDateRangeStr(map, context.period, context.mapSource);
    return formatMessage(result, context.mapSource, context.period, rangeStr);
  },

  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const { stats } = computeCycles(map, context.period, context.mapSource);
    return stats
      .filter((s) => s.hasCycle && s.phase >= 0.8)
      .sort((a, b) => b.phase - a.phase)
      .slice(0, 20)
      .map((s) => s.num);
  },
};
