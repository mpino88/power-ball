/**
 * Estrategia — Cadena de Markov Orden 2
 *
 * Extiende la cadena de Markov de orden 1 (transition_follow) a orden 2:
 * en lugar de predecir el siguiente sorteo basándose solo en el último,
 * usa el par (penúltimo sorteo → último sorteo) como estado compuesto.
 *
 * Para cada par de números consecutivos (a del penúltimo, b del último)
 * registra históricamente qué números c aparecieron en el sorteo siguiente.
 *
 * Dado el par actual (penúltimo, último), busca los sucesores comunes con
 * mayor respaldo estadístico y genera un consenso de candidatos.
 *
 * Ventaja vs orden 1: captura dependencias de dos pasos que la cadena simple
 * no puede ver. Si el patrón histórico muestra que después de A→B tiende a
 * salir C con más fuerza que después de X→B, el orden 2 lo aprovecha.
 *
 * Id: markov_order2
 */

import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";
import { mmddyyToDate, twoDigitNumbers, truncateMsg, validDateKeys, getDateRangeStr } from "./utils.js";

interface Markov2Result {
  /** matrix[(a,b)] → Map<c, count>: dado que a salió en N-1 y b en N, cuántas veces salió c en N+1 */
  matrix: Map<string, Map<number, number>>;
  lastDraw: number[];
  prevDraw: number[];
  lastDateStr: string;
  prevDateStr: string;
}

function stateKey(a: number, b: number): string {
  return `${String(a).padStart(2, "0")}_${String(b).padStart(2, "0")}`;
}

function computeMarkov2(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): Markov2Result {
  const minLen = mapSource === "p4" ? 4 : 3;
  const sortedDates = validDateKeys(map, period, mapSource);

  const matrix = new Map<string, Map<number, number>>();

  let prevNumbers: number[] = [];
  let currNumbers: number[] = [];
  let lastDraw: number[] = [];
  let prevDraw: number[] = [];
  let lastDateStr = "";
  let prevDateStr = "";

  for (const dateStr of sortedDates) {
    const draw = map[dateStr]?.[period];
    if (!draw || draw.length < minLen) {
      prevNumbers = [];
      currNumbers = [];
      continue;
    }
    if (!mmddyyToDate(dateStr)) {
      prevNumbers = [];
      currNumbers = [];
      continue;
    }

    const current = twoDigitNumbers(draw, mapSource);

    // Register transitions: for each (a in prev, b in curr) → c in current
    if (prevNumbers.length > 0 && currNumbers.length > 0) {
      for (const a of prevNumbers) {
        for (const b of currNumbers) {
          if (a < 0 || a > 99 || b < 0 || b > 99) continue;
          const key = stateKey(a, b);
          if (!matrix.has(key)) matrix.set(key, new Map());
          const row = matrix.get(key)!;
          for (const c of current) {
            if (c >= 0 && c <= 99) row.set(c, (row.get(c) ?? 0) + 1);
          }
        }
      }
    }

    prevNumbers = currNumbers;
    prevDraw = lastDraw;
    prevDateStr = lastDateStr;

    currNumbers = current;
    lastDraw = draw;
    lastDateStr = dateStr;
  }

  return { matrix, lastDraw, prevDraw, lastDateStr, prevDateStr };
}

function formatMessage(
  { matrix, lastDraw, prevDraw, lastDateStr, prevDateStr }: Markov2Result,
  mapSource: "p3" | "p4",
  period: "m" | "e",
  rangeStr: string
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  const lastNums = twoDigitNumbers(lastDraw, mapSource);
  const prevNums = twoDigitNumbers(prevDraw, mapSource);

  const lines: string[] = [
    `📊 *Cadena de Markov Orden 2* — ${mapLabel} · ${periodLabel}`,
    `Período: ${rangeStr}`,
    "",
    "📖 _Qué mide:_ dado el par \\(penúltimo→último sorteo\\), predice el siguiente usando",
    "transiciones de 2 pasos\\. Captura dependencias que Markov\\-1 no puede detectar\\.",
    `_Penúltimo_ \\(${prevDateStr}\\): ${prevNums.map((n) => String(n).padStart(2, "0")).join(", ")} · _Último_ \\(${lastDateStr}\\): ${lastNums.map((n) => String(n).padStart(2, "0")).join(", ")}`,
    "",
    "```",
    `Estado actual: [${prevNums.map((n) => String(n).padStart(2, "0")).join(",")}] → [${lastNums.map((n) => String(n).padStart(2, "0")).join(",")}]`,
    "",
  ];

  if (prevNums.length === 0 || lastNums.length === 0) {
    lines.push("Sin datos suficientes para el análisis de orden 2.");
    lines.push("```");
    return truncateMsg(lines.join("\n").trimEnd());
  }

  // Collect votes for consensus (top-5 per pair)
  const votes = new Map<number, number>();
  const weightMap = new Map<number, number>();
  let pairsWithData = 0;

  for (const a of prevNums) {
    for (const b of lastNums) {
      const key = stateKey(a, b);
      const row = matrix.get(key);
      if (!row || row.size === 0) continue;
      pairsWithData++;

      const sorted = [...row.entries()].sort((x, y) => y[1] - x[1]);
      const total = sorted.reduce((s, [, c]) => s + c, 0);
      const top6 = sorted.slice(0, 6);

      lines.push(`Par [${String(a).padStart(2, "0")}→${String(b).padStart(2, "0")}] (${total} transiciones históricas):`);
      if (top6.length === 0) {
        lines.push("  Sin datos");
      } else {
        top6.forEach(([to, count], i) => {
          const pct = total > 0 ? ((count / total) * 100).toFixed(1) : "0.0";
          lines.push(`  ${String(i + 1).padStart(2)}. ${String(to).padStart(2, "0")} → ${String(count).padStart(3)}x (${pct}%)`);
        });
        for (const [to, count] of sorted.slice(0, 5)) {
          votes.set(to, (votes.get(to) ?? 0) + 1);
          weightMap.set(to, (weightMap.get(to) ?? 0) + count);
        }
      }
      lines.push("");
    }
  }

  if (pairsWithData === 0) {
    lines.push("Sin transiciones de orden 2 registradas para este estado.");
    lines.push("Considera usar Markov Orden 1 (Seguidor de Secuencias) que tiene más datos.");
    lines.push("```");
    return truncateMsg(lines.join("\n").trimEnd());
  }

  // Consensus
  const consensus = [...votes.entries()]
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return (weightMap.get(b[0]) ?? 0) - (weightMap.get(a[0]) ?? 0);
    })
    .slice(0, 12);

  const totalPairs = prevNums.length * lastNums.length;

  if (consensus.length > 0) {
    lines.push(`★ CONSENSO ORDEN 2 (respaldo de múltiples pares):`);
    consensus.forEach(([num, v], i) => {
      const w = weightMap.get(num) ?? 0;
      lines.push(`  ${String(i + 1).padStart(2)}. ${String(num).padStart(2, "0")} — ${v}/${totalPairs} pares · ${w} trans. tot.`);
    });
  }

  lines.push("```");
  return truncateMsg(lines.join("\n").trimEnd());
}

export const markovOrder2: StrategyDefinition = {
  id: "markov_order2",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,

  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const result = computeMarkov2(map, context.period, context.mapSource);
    const rangeStr = getDateRangeStr(map, context.period, context.mapSource);
    return formatMessage(result, context.mapSource, context.period, rangeStr);
  },

  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const { matrix, lastDraw, prevDraw } = computeMarkov2(map, context.period, context.mapSource);
    const lastNums = twoDigitNumbers(lastDraw, context.mapSource);
    const prevNums = twoDigitNumbers(prevDraw, context.mapSource);

    const combined = new Map<number, number>();
    for (const a of prevNums) {
      for (const b of lastNums) {
        const row = matrix.get(stateKey(a, b)) ?? new Map<number, number>();
        for (const [to, count] of [...row.entries()].sort((x, y) => y[1] - x[1]).slice(0, 8)) {
          combined.set(to, (combined.get(to) ?? 0) + count);
        }
      }
    }
    return [...combined.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([num]) => num);
  },
};
