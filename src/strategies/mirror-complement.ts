/**
 * Estrategia — Análisis de Espejo y Complemento
 *
 * Estudia correlaciones estadísticas entre un número y sus variantes simétricas:
 *
 *   • Espejo (inversión de dígitos):    47 ↔ 74 · 03 ↔ 30 · 55 ↔ 55
 *   • Complemento a 99:                 23 ↔ 76 · 10 ↔ 89 · 50 ↔ 49
 *   • Complemento a 100:                23 ↔ 77 · 10 ↔ 90 · 50 ↔ 50
 *
 * Para cada número calcula la probabilidad condicional de que su espejo
 * o complemento aparezca en los próximos 1, 3 y 7 sorteos después de que
 * el número original salió. Esto revela si existe una correlación estructural
 * real o es solo producto del azar en los datos históricos.
 *
 * Dado el último sorteo, proyecta qué espejos y complementos tienen mayor
 * probabilidad de aparecer en el próximo sorteo basándose en dicha correlación.
 *
 * Aporta una dimensión de simetría numérica completamente nueva al sistema,
 * muy utilizada empíricamente en estrategias de lotería.
 *
 * Id: mirror_complement
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

/** Espejo: invierte los dígitos de un número 00-99. 47 → 74, 30 → 03. */
function mirror(n: number): number {
  const d = Math.floor(n / 10);
  const u = n % 10;
  return u * 10 + d;
}

/** Complemento a 99: 23 → 76. */
function comp99(n: number): number {
  return 99 - n;
}

/** Complemento a 100 (ajustado al rango 00-99): 23 → 77. */
function comp100(n: number): number {
  return (100 - n) % 100;
}

interface SymRelation {
  source: number;
  target: number;
  type: "espejo" | "comp99" | "comp100";
  timesSourceSeen: number;
  hits1: number;  // target appeared within 1 next draw
  hits3: number;  // within 3 next draws
  hits7: number;  // within 7 next draws
  pct1: number;
  pct3: number;
  pct7: number;
}

interface MirrorResult {
  relations: Map<string, SymRelation>; // key = `${source}_${type}`
  lastDraw: number[];
  lastDateStr: string;
}

function computeMirrors(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): MirrorResult {
  const minLen = mapSource === "p4" ? 4 : 3;
  const sortedDates = validDateKeys(map, period, mapSource);

  // Build ordered array of draw numbers for quick lookahead
  const drawSequence: { dateStr: string; nums: number[] }[] = [];
  for (const dateStr of sortedDates) {
    const draw = map[dateStr]?.[period];
    if (!draw || draw.length < minLen) continue;
    const nums = twoDigitNumbers(draw, mapSource);
    if (nums.length > 0) drawSequence.push({ dateStr, nums });
  }

  // Initialize relation map
  const relations = new Map<string, SymRelation>();
  const init = (source: number, target: number, type: SymRelation["type"]) => {
    const key = `${source}_${type}`;
    if (!relations.has(key)) {
      relations.set(key, {
        source, target, type,
        timesSourceSeen: 0, hits1: 0, hits3: 0, hits7: 0,
        pct1: 0, pct3: 0, pct7: 0,
      });
    }
  };

  for (let n = 0; n < 100; n++) {
    const m = mirror(n);
    const c99 = comp99(n);
    const c100 = comp100(n);
    if (m !== n) init(n, m, "espejo");
    if (c99 !== n && c99 !== m) init(n, c99, "comp99");
    if (c100 !== n && c100 !== m && c100 !== c99) init(n, c100, "comp100");
  }

  // Scan sequence
  for (let i = 0; i < drawSequence.length; i++) {
    const { nums } = drawSequence[i]!;

    for (const source of nums) {
      if (source < 0 || source > 99) continue;

      const relKeys: Array<[string, number]> = [];
      const m = mirror(source);
      const c99 = comp99(source);
      const c100 = comp100(source);

      if (m !== source) relKeys.push([`${source}_espejo`, m]);
      if (c99 !== source && c99 !== m) relKeys.push([`${source}_comp99`, c99]);
      if (c100 !== source && c100 !== m && c100 !== c99) relKeys.push([`${source}_comp100`, c100]);

      for (const [key, target] of relKeys) {
        const rel = relations.get(key);
        if (!rel) continue;
        rel.timesSourceSeen++;

        // Check next 7 draws
        const next7 = drawSequence.slice(i + 1, i + 8);
        for (let j = 0; j < next7.length; j++) {
          const found = next7[j]!.nums.includes(target);
          if (found) {
            rel.hits7++;
            if (j < 3) rel.hits3++;
            if (j < 1) rel.hits1++;
            break; // count only the first hit
          }
        }
      }
    }
  }

  // Compute percentages
  for (const rel of relations.values()) {
    if (rel.timesSourceSeen > 0) {
      rel.pct1 = (rel.hits1 / rel.timesSourceSeen) * 100;
      rel.pct3 = (rel.hits3 / rel.timesSourceSeen) * 100;
      rel.pct7 = (rel.hits7 / rel.timesSourceSeen) * 100;
    }
  }

  const last = drawSequence.at(-1);
  return {
    relations,
    lastDraw: last ? map[last.dateStr]![period]! : [],
    lastDateStr: last?.dateStr ?? "",
  };
}

function formatMessage(
  { relations, lastDraw, lastDateStr }: MirrorResult,
  mapSource: "p3" | "p4",
  period: "m" | "e",
  rangeStr: string
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";
  const lastNums = twoDigitNumbers(lastDraw, mapSource);

  const lines: string[] = [
    `📊 *Espejo y Complemento* — ${mapLabel} · ${periodLabel}`,
    `Período: ${rangeStr} · Último sorteo: ${lastDateStr}`,
    "",
    "📖 _Qué mide:_ correlación entre un número y sus variantes simétricas\\.",
    "• _Espejo_: 47↔74 \\(dígitos invertidos\\) · _Comp99_: 23↔76 \\(99\\-n\\) · _Comp100_: 23↔77 \\(100\\-n\\)",
    "_Pct1/3/7_: % veces que el simétrico apareció en los siguientes 1/3/7 sorteos\\.",
    `_Último sorteo_: ${lastNums.map((n) => String(n).padStart(2, "0")).join(", ")} — proyección de sus simétricos:`,
    "",
    "```",
  ];

  if (lastNums.length === 0) {
    lines.push("Sin datos del último sorteo.");
    lines.push("```");
    return truncateMsg(lines.join("\n").trimEnd());
  }

  // For last draw numbers, show their symmetric candidates
  lines.push("CANDIDATOS SIMÉTRICOS DEL ÚLTIMO SORTEO");
  lines.push("Num  Tipo      Simétrico  Veces  Pct1%  Pct3%  Pct7%");
  lines.push("──────────────────────────────────────────────────────");

  const candidateScores = new Map<number, number>();

  for (const source of lastNums) {
    if (source < 0 || source > 99) continue;
    const types: Array<[string, SymRelation["type"]]> = [
      [`${source}_espejo`, "espejo"],
      [`${source}_comp99`, "comp99"],
      [`${source}_comp100`, "comp100"],
    ];
    for (const [key, type] of types) {
      const rel = relations.get(key);
      if (!rel || rel.timesSourceSeen < 3) continue;
      const sn = String(rel.source).padStart(2, "0");
      const tn = String(rel.target).padStart(2, "0");
      const typeLabel = type === "espejo" ? "Espejo  " : type === "comp99" ? "Comp-99 " : "Comp-100";
      const p1 = `${rel.pct1.toFixed(1)}%`.padStart(6);
      const p3 = `${rel.pct3.toFixed(1)}%`.padStart(6);
      const p7 = `${rel.pct7.toFixed(1)}%`.padStart(6);
      lines.push(`${sn}   ${typeLabel}  ${tn}        ${String(rel.timesSourceSeen).padStart(4)}  ${p1}  ${p3}  ${p7}`);
      // Weight: pct7 * 1 + pct3 * 2 + pct1 * 3 (more weight to sooner appearance)
      const score = rel.pct1 * 3 + rel.pct3 * 2 + rel.pct7;
      candidateScores.set(rel.target, (candidateScores.get(rel.target) ?? 0) + score);
    }
  }

  lines.push("");

  // Top overall symmetric relations (not just from last draw)
  lines.push("TOP 15 CORRELACIONES SIMÉTRICAS MÁS FUERTES (toda la historia)");
  lines.push("Num → Simétrico  Tipo      Veces  Pct3%  Pct7%");
  lines.push("──────────────────────────────────────────────────");

  const allRels = [...relations.values()]
    .filter((r) => r.timesSourceSeen >= 5)
    .sort((a, b) => b.pct3 - a.pct3)
    .slice(0, 15);

  for (const rel of allRels) {
    const sn = String(rel.source).padStart(2, "0");
    const tn = String(rel.target).padStart(2, "0");
    const typeLabel = rel.type === "espejo" ? "Espejo  " : rel.type === "comp99" ? "Comp-99 " : "Comp-100";
    const p3 = `${rel.pct3.toFixed(1)}%`.padStart(6);
    const p7 = `${rel.pct7.toFixed(1)}%`.padStart(6);
    lines.push(`${sn} → ${tn}        ${typeLabel}  ${String(rel.timesSourceSeen).padStart(4)}  ${p3}  ${p7}`);
  }

  if (candidateScores.size > 0) {
    lines.push("");
    lines.push("★ CANDIDATOS PROYECTADOS (simétricos del último sorteo, por score):");
    const top = [...candidateScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    top.forEach(([n, s], i) => {
      lines.push(`  ${i + 1}. ${String(n).padStart(2, "0")}  (score: ${s.toFixed(1)})`);
    });
  }

  lines.push("```");
  return truncateMsg(lines.join("\n").trimEnd());
}

export const mirrorComplement: StrategyDefinition = {
  id: "mirror_complement",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,

  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const result = computeMirrors(map, context.period, context.mapSource);
    const rangeStr = getDateRangeStr(map, context.period, context.mapSource);
    return formatMessage(result, context.mapSource, context.period, rangeStr);
  },

  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const { relations, lastDraw } = computeMirrors(map, context.period, context.mapSource);
    const lastNums = twoDigitNumbers(lastDraw, context.mapSource);

    const scores = new Map<number, number>();

    for (const source of lastNums) {
      if (source < 0 || source > 99) continue;
      for (const type of ["espejo", "comp99", "comp100"] as const) {
        const rel = relations.get(`${source}_${type}`);
        if (!rel || rel.timesSourceSeen < 3) continue;
        const score = rel.pct1 * 3 + rel.pct3 * 2 + rel.pct7;
        scores.set(rel.target, (scores.get(rel.target) ?? 0) + score);
      }
    }

    // Fallback: top by pct3 across all relations if no last draw data
    if (scores.size === 0) {
      return [...relations.values()]
        .filter((r) => r.timesSourceSeen >= 5)
        .sort((a, b) => b.pct3 - a.pct3)
        .slice(0, 20)
        .map((r) => r.target);
    }

    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([n]) => n);
  },
};
