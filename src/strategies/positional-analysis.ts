/**
 * Estrategia 6 — Análisis Posicional
 *
 * Descompone cada sorteo según la estructura real del juego:
 *
 *   P3 (Fijo): A B C
 *     · Posición 1 = Centena  (dígito 0-9)
 *     · Posición 2 = Decena   (dígito 0-9)
 *     · Posición 3 = Unidad   (dígito 0-9)
 *     → Para cada posición: frecuencia de cada dígito, probabilidad %,
 *       días sin salir y factor de deuda.
 *
 *   P4 (Corrido): A B C D  →  [AB] [CD]
 *     · Par 1 = AB  (número 00-99, decena=A, unidad=B)
 *     · Par 2 = CD  (número 00-99, decena=C, unidad=D)
 *     → Para cada par: top 00-99 + análisis de su decena y su unidad.
 *
 * Siempre separado por período (Mediodía / Noche).
 *
 * Id: positional_analysis
 */

import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";
import { mmddyyToDate, truncateMsg, validDateKeys, p3Positions, p4Pairs, DAY_NAMES, MONTH_NAMES } from "./utils.js";

// ─── Shared helpers ──────────────────────────────────────────────────────────

interface DigitRow {
  digit: number;   // 0-9
  count: number;
  daysSince: number;
  avgGap: number;
  dueFactor: number;
}

interface PairRow {
  num: number;     // 00-99
  count: number;
  daysSince: number;
  avgGap: number;
  dueFactor: number;
}

/** Builds frequency + gap stats for each value in 0..maxVal from a list of (date, value) events. */
function buildStats(
  events: { date: Date; value: number }[],
  maxVal: number
): Map<number, { count: number; dates: Date[] }> {
  const map = new Map<number, { count: number; dates: Date[] }>();
  for (let v = 0; v <= maxVal; v++) map.set(v, { count: 0, dates: [] });

  for (const { date, value } of events) {
    if (value < 0 || value > maxVal) continue;
    const s = map.get(value)!;
    s.count++;
    s.dates.push(date);
  }
  return map;
}

function toDigitRows(
  statsMap: Map<number, { count: number; dates: Date[] }>,
  today: Date
): DigitRow[] {
  const rows: DigitRow[] = [];
  for (const [digit, { count, dates }] of statsMap) {
    dates.sort((a, b) => a.getTime() - b.getTime());
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(Math.floor((dates[i]!.getTime() - dates[i - 1]!.getTime()) / 86_400_000));
    }
    const avgGap = gaps.length > 0 ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
    const lastDate = dates.at(-1) ?? null;
    const daysSince = lastDate
      ? Math.floor((today.getTime() - lastDate.getTime()) / 86_400_000)
      : 9999;
    const dueFactor = avgGap > 0 ? daysSince / avgGap : 0;
    rows.push({ digit, count, daysSince, avgGap, dueFactor });
  }
  return rows;
}

function toPairRows(
  statsMap: Map<number, { count: number; dates: Date[] }>,
  today: Date
): PairRow[] {
  const rows: PairRow[] = [];
  for (const [num, { count, dates }] of statsMap) {
    if (count === 0) continue;
    dates.sort((a, b) => a.getTime() - b.getTime());
    const gaps: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      gaps.push(Math.floor((dates[i]!.getTime() - dates[i - 1]!.getTime()) / 86_400_000));
    }
    const avgGap = gaps.length > 0 ? gaps.reduce((s, g) => s + g, 0) / gaps.length : 0;
    const lastDate = dates.at(-1) ?? null;
    const daysSince = lastDate
      ? Math.floor((today.getTime() - lastDate.getTime()) / 86_400_000)
      : 9999;
    const dueFactor = avgGap > 0 ? daysSince / avgGap : 0;
    rows.push({ num, count, daysSince, avgGap, dueFactor });
  }
  return rows.sort((a, b) => b.count - a.count);
}

const dueIcon = (f: number) => (f >= 2.0 ? "🔴" : f >= 1.5 ? "🟠" : f >= 1.0 ? "🟡" : "  ");

// ─── P3 Analysis ─────────────────────────────────────────────────────────────

function analyzeP3(map: DateDrawsMap, period: "m" | "e"): string {
  const dates = validDateKeys(map, period, "p3");
  const today = new Date();

  // Collect events per position
  const posEvents: { date: Date; value: number }[][] = [[], [], []];

  // Calendar: (dayOfWeek, month) → position → digit → count
  const calDowMonth = new Map<string, Map<number, Map<number, number>>>();

  for (const dateStr of dates) {
    const draw = map[dateStr]?.[period];
    if (!draw) continue;
    const pos = p3Positions(draw);
    if (!pos) continue;
    const date = mmddyyToDate(dateStr);
    if (!date) continue;

    for (let p = 0; p < 3; p++) {
      posEvents[p]!.push({ date, value: pos[p]! });
    }

    // Calendar accumulation
    const dow = date.getDay();
    const month = date.getMonth() + 1;
    const key = `${dow}_${month}`;
    if (!calDowMonth.has(key)) calDowMonth.set(key, new Map());
    const calPos = calDowMonth.get(key)!;
    for (let p = 0; p < 3; p++) {
      if (!calPos.has(p)) calPos.set(p, new Map());
      const calDigit = calPos.get(p)!;
      const d = pos[p]!;
      calDigit.set(d, (calDigit.get(d) ?? 0) + 1);
    }
  }

  // Estimate next draw date
  const latestDateStr = dates.at(-1) ?? "";
  const latestDate = latestDateStr ? mmddyyToDate(latestDateStr) : null;
  let nextDate: Date | null = null;
  let nextDateLabel = "N/A";
  if (latestDate) {
    nextDate = new Date(latestDate);
    nextDate.setDate(nextDate.getDate() + 1);
    const mm = String(nextDate.getMonth() + 1).padStart(2, "0");
    const dd = String(nextDate.getDate()).padStart(2, "0");
    const yy = String(nextDate.getFullYear()).slice(-2);
    nextDateLabel = `${mm}/${dd}/${yy} (${DAY_NAMES[nextDate.getDay()]}, ${MONTH_NAMES[nextDate.getMonth()]})`;
  }

  // Calendar top-1 per position for the next date
  const calTop1: (string | null)[] = [null, null, null];
  if (nextDate) {
    const dow = nextDate.getDay();
    const month = nextDate.getMonth() + 1;
    const key = `${dow}_${month}`;
    const calPos = calDowMonth.get(key);
    for (let p = 0; p < 3; p++) {
      if (!calPos?.has(p)) continue;
      const calDigit = calPos.get(p)!;
      let best = -1;
      let bestCount = 0;
      for (const [d, c] of calDigit) {
        if (c > bestCount) { bestCount = c; best = d; }
      }
      if (best >= 0) calTop1[p] = `${best}(${bestCount}x)`;
    }
  }

  const POS_LABELS = ["Centena (pos.1)", "Decena  (pos.2)", "Unidad  (pos.3)"];
  const totalDraws = dates.length;
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";

  const lines: string[] = [
    `📊 *Análisis Posicional* — P3 (Fijos) · ${periodLabel}`,
    `Sorteos: ${totalDraws} · Último: ${latestDateStr} · Próx. estimado: ${nextDateLabel}`,
    "",
    "📖 _Qué mide:_ cada dígito del sorteo \\[C\\]\\[D\\]\\[U\\] analizado de forma independiente por posición\\.",
    "_Prob%_ = probabilidad en esa posición · _Factor_ = Gap\\-deuda \\(>1x = dígito atrasado en esa posición\\)",
    "_Probable próx\\:_ dígito más frecuente para esa posición en el contexto \\(día semana\\+mes\\) estimado",
    "",
    "```",
  ];

  for (let p = 0; p < 3; p++) {
    const statsMap = buildStats(posEvents[p]!, 9);
    const rows = toDigitRows(statsMap, today).sort((a, b) => b.count - a.count);
    const total = rows.reduce((s, r) => s + r.count, 0);
    const calHint = calTop1[p] ? ` · Probable próx: ${calTop1[p]!}` : "";

    lines.push(`── ${POS_LABELS[p]!}${calHint} ──`);
    lines.push("Díg  Count  Prob%   DíasSin  Factor");
    lines.push("─────────────────────────────────────");

    for (const row of rows) {
      const d = String(row.digit);
      const c = String(row.count).padStart(4);
      const pct = (total > 0 ? (row.count / total) * 100 : 0).toFixed(1).padStart(5);
      const ds = row.daysSince < 9999 ? String(row.daysSince).padStart(5) + "d" : " nuncad";
      const df = row.avgGap > 0 ? `${row.dueFactor.toFixed(1)}x` : "  — ";
      lines.push(`${d}    ${c}  ${pct}%  ${ds}    ${df} ${dueIcon(row.dueFactor)}`);
    }
    lines.push("");
  }

  lines.push("🔴≥2x · 🟠≥1.5x · 🟡≥1x = número debido en esa posición");
  lines.push("```");

  return truncateMsg(lines.join("\n").trimEnd());
}

// ─── P4 Analysis ─────────────────────────────────────────────────────────────

function analyzeP4(map: DateDrawsMap, period: "m" | "e"): string {
  const dates = validDateKeys(map, period, "p4");
  const today = new Date();

  // pairEvents[0] = Par1 (AB), pairEvents[1] = Par2 (CD)  — as 00-99
  // decEvents[pairIdx][decena 0-9], uniEvents[pairIdx][unidad 0-9]
  const pairEvents: { date: Date; value: number }[][] = [[], []];
  const decEvents: { date: Date; value: number }[][] = [[], []];
  const uniEvents: { date: Date; value: number }[][] = [[], []];

  // Calendar: (dow, month) → number 00-99 → count  (one map per pair index)
  const calDowMonthPair: Map<string, Map<number, number>>[] = [
    new Map(),
    new Map(),
  ];

  for (const dateStr of dates) {
    const draw = map[dateStr]?.[period];
    if (!draw) continue;
    const pairs = p4Pairs(draw);
    if (!pairs) continue;
    const date = mmddyyToDate(dateStr);
    if (!date) continue;

    for (let pi = 0; pi < 2; pi++) {
      const num = pairs[pi]!;
      const dec = Math.floor(num / 10);
      const uni = num % 10;

      pairEvents[pi]!.push({ date, value: num });
      decEvents[pi]!.push({ date, value: dec });
      uniEvents[pi]!.push({ date, value: uni });

      const dow = date.getDay();
      const month = date.getMonth() + 1;
      const key = `${dow}_${month}`;
      if (!calDowMonthPair[pi]!.has(key)) calDowMonthPair[pi]!.set(key, new Map());
      const calPair = calDowMonthPair[pi]!.get(key)!;
      calPair.set(num, (calPair.get(num) ?? 0) + 1);
    }
  }

  const latestDateStr = dates.at(-1) ?? "";
  const latestDate = latestDateStr ? mmddyyToDate(latestDateStr) : null;
  let nextDate: Date | null = null;
  let nextDateLabel = "N/A";
  if (latestDate) {
    nextDate = new Date(latestDate);
    nextDate.setDate(nextDate.getDate() + 1);
    const mm = String(nextDate.getMonth() + 1).padStart(2, "0");
    const dd = String(nextDate.getDate()).padStart(2, "0");
    const yy = String(nextDate.getFullYear()).slice(-2);
    nextDateLabel = `${mm}/${dd}/${yy} (${DAY_NAMES[nextDate.getDay()]}, ${MONTH_NAMES[nextDate.getMonth()]})`;
  }

  // Calendar top-3 per pair for next date
  const calTop3: ({ num: number; count: number }[] | null)[] = [null, null];
  if (nextDate) {
    const dow = nextDate.getDay();
    const month = nextDate.getMonth() + 1;
    const key = `${dow}_${month}`;
    for (let pi = 0; pi < 2; pi++) {
      const calPair = calDowMonthPair[pi]!.get(key);
      if (!calPair) continue;
      const sorted = [...calPair.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([num, count]) => ({ num, count }));
      if (sorted.length > 0) calTop3[pi] = sorted;
    }
  }

  const PAIR_LABELS = ["Par 1  [A·B] → dígitos 1-2", "Par 2  [C·D] → dígitos 3-4"];
  const totalDraws = dates.length;
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";

  const lines: string[] = [
    `📊 *Análisis Posicional* — P4 (Corridos) · ${periodLabel}`,
    `Sorteos: ${totalDraws} · Formato: \\[AB\\]\\[CD\\] · Último: ${latestDateStr} · Próx: ${nextDateLabel}`,
    "",
    "📖 _Qué mide:_ el sorteo \\[ABCD\\] se divide en 2 pares NO solapados: Par1=\\[AB\\] y Par2=\\[CD\\]\\.",
    "Para cada par: top números 00\\-99 + análisis de su _Decena_ \\(dígito izq\\.\\) y su _Unidad_ \\(dígito der\\.\\)",
    "_Factor_ = Gap\\-deuda · _Cal:_ = candidatos del par según patrón \\(día semana\\+mes\\) de la próxima fecha",
    "",
    "```",
  ];

  for (let pi = 0; pi < 2; pi++) {
    // Pair-level stats (00-99)
    const pairStatsMap = buildStats(pairEvents[pi]!, 99);
    const pairRows = toPairRows(pairStatsMap, today).slice(0, 12);
    const pairTotal = pairEvents[pi]!.length;

    // Decena stats (0-9)
    const decStatsMap = buildStats(decEvents[pi]!, 9);
    const decRows = toDigitRows(decStatsMap, today).sort((a, b) => b.count - a.count);
    const decTotal = decEvents[pi]!.length;

    // Unidad stats (0-9)
    const uniStatsMap = buildStats(uniEvents[pi]!, 9);
    const uniRows = toDigitRows(uniStatsMap, today).sort((a, b) => b.count - a.count);
    const uniTotal = uniEvents[pi]!.length;

    const calHint =
      calTop3[pi]
        ? ` · Cal: ${calTop3[pi]!.map((x) => `${String(x.num).padStart(2, "0")}(${x.count}x)`).join(", ")}`
        : "";

    lines.push(`══ ${PAIR_LABELS[pi]!}${calHint} ══`);
    lines.push("");

    // Top 12 pairs
    lines.push("Número (00-99)  Count  Prob%  DíasSin  Factor");
    lines.push("───────────────────────────────────────────────");
    for (const row of pairRows) {
      const n = String(row.num).padStart(2, "0");
      const c = String(row.count).padStart(4);
      const pct = (pairTotal > 0 ? (row.count / pairTotal) * 100 : 0).toFixed(1).padStart(5);
      const ds = row.daysSince < 9999 ? String(row.daysSince).padStart(5) + "d" : " nunca";
      const df = row.avgGap > 0 ? `${row.dueFactor.toFixed(1)}x` : "  —";
      lines.push(`    ${n}         ${c}  ${pct}%   ${ds}   ${df} ${dueIcon(row.dueFactor)}`);
    }

    lines.push("");

    // Decena + Unidad side-by-side (compact)
    lines.push("  Decena (dígito izq.)         Unidad (dígito der.)");
    lines.push("  Díg  Count  Prob   Due        Díg  Count  Prob   Due");
    lines.push("  ─────────────────────────     ─────────────────────────");
    for (let i = 0; i < 10; i++) {
      const dr = decRows[i];
      const ur = uniRows[i];
      const dRow = dr
        ? `  ${dr.digit}    ${String(dr.count).padStart(4)}  ${(decTotal > 0 ? (dr.count / decTotal) * 100 : 0).toFixed(1).padStart(4)}%  ${dr.avgGap > 0 ? dr.dueFactor.toFixed(1) + "x" : " — "} ${dueIcon(dr.dueFactor)}`
        : "";
      const uRow = ur
        ? `     ${ur.digit}    ${String(ur.count).padStart(4)}  ${(uniTotal > 0 ? (ur.count / uniTotal) * 100 : 0).toFixed(1).padStart(4)}%  ${ur.avgGap > 0 ? ur.dueFactor.toFixed(1) + "x" : " — "} ${dueIcon(ur.dueFactor)}`
        : "";
      if (dRow || uRow) lines.push(`${dRow.padEnd(28)}${uRow}`);
    }
    lines.push("");
  }

  lines.push("🔴≥2x · 🟠≥1.5x · 🟡≥1x = número/dígito debido");
  lines.push("```");

  return truncateMsg(lines.join("\n").trimEnd());
}

// ─── Strategy definition ─────────────────────────────────────────────────────

export const positionalAnalysis: StrategyDefinition = {
  id: "positional_analysis",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,
  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    return context.mapSource === "p3"
      ? analyzeP3(map, context.period)
      : analyzeP4(map, context.period);
  },
};
