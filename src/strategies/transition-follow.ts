/**
 * Estrategia 4 — Seguidor de Secuencias (Cadena de Markov de orden 1)
 *
 * Construye una matriz de transición: dado que el número X salió en el sorteo N,
 * ¿qué número Y apareció más frecuentemente en el sorteo N+1?
 *
 * Dado el último sorteo registrado, muestra:
 *   1. Los sucesores más probables para cada número del último draw
 *   2. Un "consenso" con números que aparecen como candidatos de varios predecesores
 *
 * Es la estrategia con mayor enfoque predictivo para el PRÓXIMO sorteo concreto.
 *
 * Id: transition_follow
 */

import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";
import { mmddyyToDate, twoDigitNumbers, truncateMsg, validDateKeys } from "./utils.js";

interface TransitionResult {
  matrix: Map<number, Map<number, number>>;
  lastDraw: number[];
  lastDateStr: string;
}

function computeTransitions(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): TransitionResult {
  const minLen = mapSource === "p4" ? 4 : 3;
  const sortedDates = validDateKeys(map, period, mapSource);

  const matrix = new Map<number, Map<number, number>>();
  for (let n = 0; n < 100; n++) matrix.set(n, new Map());

  let prevNumbers: number[] = [];
  let lastDraw: number[] = [];
  let lastDateStr = "";

  for (const dateStr of sortedDates) {
    const draw = map[dateStr]?.[period];
    if (!draw || draw.length < minLen) {
      prevNumbers = [];
      continue;
    }
    const date = mmddyyToDate(dateStr);
    if (!date) {
      prevNumbers = [];
      continue;
    }

    const current = twoDigitNumbers(draw, mapSource);

    for (const from of prevNumbers) {
      for (const to of current) {
        if (from >= 0 && from <= 99 && to >= 0 && to <= 99) {
          const row = matrix.get(from)!;
          row.set(to, (row.get(to) ?? 0) + 1);
        }
      }
    }

    prevNumbers = current;
    lastDraw = draw;
    lastDateStr = dateStr;
  }

  return { matrix, lastDraw, lastDateStr };
}

function formatMessage(
  { matrix, lastDraw, lastDateStr }: TransitionResult,
  mapSource: "p3" | "p4",
  period: "m" | "e"
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  const lastNums = twoDigitNumbers(lastDraw, mapSource);
  const drawStr = lastDraw.join("-");

  const lines: string[] = [
    `📊 *Seguidor de Secuencias* — ${mapLabel} · ${periodLabel}`,
    `Último sorteo (${lastDateStr}): ${drawStr}`,
    "",
    "📖 _Qué mide:_ Cadena de Markov — dado que X salió, ¿qué número Y apareció en el sorteo SIGUIENTE?",
    "_nx \\(p%\\)_ = Y apareció n veces después de X, con p% de probabilidad histórica de transición",
    "→ _CONSENSO_ = números elegidos por múltiples predecesores del último draw \\(mayor respaldo\\)",
    "",
    "```",
    `Números extraídos: ${lastNums.map((n) => String(n).padStart(2, "0")).join(", ")}`,
    "",
  ];

  // Votes for consensus (top-5 successors of each predecessor)
  const votes = new Map<number, number>();

  for (const from of lastNums) {
    const row = matrix.get(from) ?? new Map<number, number>();
    const sorted = [...row.entries()]
      .sort((a, b) => b[1] - a[1]);
    const total = sorted.reduce((s, [, c]) => s + c, 0);
    const top8 = sorted.slice(0, 8);

    lines.push(
      `Después de ${String(from).padStart(2, "0")} (${total} transiciones históricas):`
    );

    if (top8.length === 0) {
      lines.push("  Sin datos históricos suficientes");
    } else {
      top8.forEach(([to, count], i) => {
        const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
        lines.push(
          `  ${String(i + 1).padStart(2)}. ${String(to).padStart(2, "0")} → ${String(count).padStart(3)}x (${pct}%)`
        );
      });
      // Accumulate votes for consensus
      for (const [to] of sorted.slice(0, 5)) {
        votes.set(to, (votes.get(to) ?? 0) + 1);
      }
    }
    lines.push("");
  }

  // Consensus: numbers voted by 2+ predecessors
  const consensus = [...votes.entries()]
    .filter(([, v]) => v >= Math.min(2, lastNums.length))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (consensus.length > 0) {
    lines.push("★ CONSENSO (candidatos de múltiples números anteriores):");
    consensus.forEach(([num, v], i) => {
      lines.push(
        `  ${String(i + 1).padStart(2)}. ${String(num).padStart(2, "0")} — ${v}/${lastNums.length} votos`
      );
    });
  }

  lines.push("```");
  return truncateMsg(lines.join("\n").trimEnd());
}

export const transitionFollow: StrategyDefinition = {
  id: "transition_follow",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,
  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const result = computeTransitions(map, context.period, context.mapSource);
    return formatMessage(result, context.mapSource, context.period);
  },
  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const { matrix, lastDraw } = computeTransitions(map, context.period, context.mapSource);
    const lastNums = twoDigitNumbers(lastDraw, context.mapSource);
    const combined = new Map<number, number>();
    for (const from of lastNums) {
      const row = matrix.get(from) ?? new Map<number, number>();
      const sorted = [...row.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
      for (const [to, count] of sorted) {
        combined.set(to, (combined.get(to) ?? 0) + count);
      }
    }
    return [...combined.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([num]) => num);
  },
};
