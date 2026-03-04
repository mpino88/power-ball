/**
 * Estrategia 3 — Patrón Calendario
 *
 * Analiza la relación entre el calendario y los números que salen:
 *   A) Día de la semana + Mes (combinación exacta): patrón más específico
 *   B) Día de la semana (en general)
 *   C) Mes del año (en general)
 *   D) Día del mes (1-31)
 *
 * Dado el último registro en la base de conocimiento, estima la fecha del
 * próximo sorteo y muestra los números más probables para ese contexto exacto.
 *
 * Id: calendar_pattern
 */

import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";
import {
  mmddyyToDate,
  twoDigitNumbers,
  truncateMsg,
  validDateKeys,
  DAY_NAMES,
  MONTH_NAMES,
} from "./utils.js";

type CountMap = Map<number, number>;

interface CalendarPatterns {
  byDow: Map<number, CountMap>;      // 0-6
  byMonth: Map<number, CountMap>;    // 1-12
  byDom: Map<number, CountMap>;      // 1-31
  byDowMonth: Map<string, CountMap>; // "dow_month"
  latestDateStr: string;
  latestDate: Date | null;
}

function computeCalendarPatterns(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): CalendarPatterns {
  const minLen = mapSource === "p4" ? 4 : 3;
  const sortedDates = validDateKeys(map, period, mapSource);

  const byDow = new Map<number, CountMap>();
  const byMonth = new Map<number, CountMap>();
  const byDom = new Map<number, CountMap>();
  const byDowMonth = new Map<string, CountMap>();

  for (let d = 0; d <= 6; d++) byDow.set(d, new Map());
  for (let m = 1; m <= 12; m++) byMonth.set(m, new Map());
  for (let d = 1; d <= 31; d++) byDom.set(d, new Map());

  const inc = (cmap: CountMap, num: number) =>
    cmap.set(num, (cmap.get(num) ?? 0) + 1);

  for (const dateStr of sortedDates) {
    const draw = map[dateStr]?.[period];
    if (!draw || draw.length < minLen) continue;
    const date = mmddyyToDate(dateStr);
    if (!date) continue;

    const dow = date.getDay();
    const month = date.getMonth() + 1;
    const dom = date.getDate();
    const dmKey = `${dow}_${month}`;

    if (!byDowMonth.has(dmKey)) byDowMonth.set(dmKey, new Map());

    for (const num of twoDigitNumbers(draw, mapSource)) {
      if (num < 0 || num > 99) continue;
      inc(byDow.get(dow)!, num);
      inc(byMonth.get(month)!, num);
      inc(byDom.get(dom)!, num);
      inc(byDowMonth.get(dmKey)!, num);
    }
  }

  const latestDateStr = sortedDates.at(-1) ?? "";
  const latestDate = latestDateStr ? mmddyyToDate(latestDateStr) : null;

  return { byDow, byMonth, byDom, byDowMonth, latestDateStr, latestDate };
}

function topN(cmap: CountMap, n: number): { num: number; count: number }[] {
  const items: { num: number; count: number }[] = [];
  for (const [num, count] of cmap.entries()) {
    if (count > 0) items.push({ num, count });
  }
  return items.sort((a, b) => b.count - a.count).slice(0, n);
}

function section(
  title: string,
  items: { num: number; count: number }[],
  lines: string[]
) {
  lines.push(title);
  if (items.length === 0) {
    lines.push("  Sin datos suficientes");
  } else {
    items.forEach((s, i) => {
      lines.push(
        `  ${String(i + 1).padStart(2)}. ${String(s.num).padStart(2, "0")} (${s.count}x)`
      );
    });
  }
  lines.push("");
}

function formatMessage(
  { byDow, byMonth, byDom, byDowMonth, latestDateStr, latestDate }: CalendarPatterns,
  mapSource: "p3" | "p4",
  period: "m" | "e"
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

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

  const lines: string[] = [
    `📊 *Patrón Calendario* — ${mapLabel} · ${periodLabel}`,
    `Último: ${latestDateStr} · Próx. estimado: ${nextDateLabel}`,
    "",
    "📖 _Qué mide:_ qué números salen más según el contexto de la PRÓXIMA fecha estimada\\.",
    "_4 dimensiones_: ①\\(día semana\\+mes\\) combinación exacta · ② día semana · ③ mes · ④ día del mes",
    "→ Prioriza números que aparecen en _varias_ secciones a la vez · \\(nx\\) = veces históricas",
    "",
    "```",
  ];

  if (nextDate) {
    const dow = nextDate.getDay();
    const month = nextDate.getMonth() + 1;
    const dom = nextDate.getDate();
    const dmKey = `${dow}_${month}`;

    // Most specific: (day-of-week, month) combo
    section(
      `${DAY_NAMES[dow]}S DE ${MONTH_NAMES[month - 1].toUpperCase()} (combinación exacta):`,
      topN(byDowMonth.get(dmKey) ?? new Map(), 10),
      lines
    );

    section(
      `${DAY_NAMES[dow]}S EN GENERAL:`,
      topN(byDow.get(dow) ?? new Map(), 10),
      lines
    );

    section(
      `MES DE ${MONTH_NAMES[month - 1].toUpperCase()} EN GENERAL:`,
      topN(byMonth.get(month) ?? new Map(), 10),
      lines
    );

    section(
      `DÍA ${dom} DE CADA MES:`,
      topN(byDom.get(dom) ?? new Map(), 10),
      lines
    );
  }

  lines.push("```");
  return truncateMsg(lines.join("\n").trimEnd());
}

export const calendarPattern: StrategyDefinition = {
  id: "calendar_pattern",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,
  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const patterns = computeCalendarPatterns(map, context.period, context.mapSource);
    return formatMessage(patterns, context.mapSource, context.period);
  },
  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const { byDow, byMonth, byDom, byDowMonth, latestDate } = computeCalendarPatterns(
      map,
      context.period,
      context.mapSource
    );
    const nextDate = latestDate ? new Date(latestDate.getTime() + 86_400_000) : new Date();
    const dow = nextDate.getDay();
    const month = nextDate.getMonth() + 1;
    const dom = nextDate.getDate();
    const dmKey = `${dow}_${month}`;

    const pickTop = (cmap: Map<number, number>, n: number): number[] =>
      [...cmap.entries()]
        .filter(([, c]) => c > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([num]) => num);

    const seen = new Set<number>();
    const result: number[] = [];
    for (const num of [
      ...pickTop(byDowMonth.get(dmKey) ?? new Map(), 10),
      ...pickTop(byDow.get(dow) ?? new Map(), 10),
      ...pickTop(byMonth.get(month) ?? new Map(), 10),
      ...pickTop(byDom.get(dom) ?? new Map(), 10),
    ]) {
      if (!seen.has(num)) {
        seen.add(num);
        result.push(num);
      }
    }
    return result.slice(0, 20);
  },
};
