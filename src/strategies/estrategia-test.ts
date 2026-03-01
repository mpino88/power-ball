/**
 * Estrategia test: top 10 números (00-99) que más han salido cada día de la semana.
 * Base de conocimientos: P3 o P4. Menú contextual: P3/P4 + Mediodía/Noche.
 * Un archivo por estrategia: lógica, menú y resolución en un solo sitio.
 */

import type { StrategyContext, StrategyDefinition } from "./types.js";
import type { DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";

/** Día de la semana: 0=Dom, 1=Lun, …, 6=Sáb. */
type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** Conteos por número (0-99) y por día. */
type CountMap = Map<number, Map<DayOfWeek, number>>;

const DAY_LABELS: Record<DayOfWeek, string> = {
  0: "Dom", 1: "Lun", 2: "Mar", 3: "Mié", 4: "Jue", 5: "Vie", 6: "Sáb",
};

function mmddyyToDate(key: string): Date | null {
  const m = key.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return null;
  const mm = parseInt(m[1], 10);
  const dd = parseInt(m[2], 10);
  let yy = parseInt(m[3], 10);
  yy = yy >= 50 ? 1900 + yy : 2000 + yy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(yy, mm - 1, dd);
  if (d.getDate() !== dd || d.getMonth() !== mm - 1) return null;
  return d;
}

function sortDateKeys(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const da = mmddyyToDate(a)?.getTime() ?? 0;
    const db = mmddyyToDate(b)?.getTime() ?? 0;
    return da - db;
  });
}

function twoDigitNumbersFromP3(draw: number[]): number[] {
  if (draw.length < 3) return [];
  const [a, b, c] = [draw[0]!, draw[1]!, draw[2]!];
  return [a * 10 + b, b * 10 + c];
}

function twoDigitNumbersFromP4(draw: number[]): number[] {
  if (draw.length < 4) return [];
  const [a, b, c, d] = [draw[0]!, draw[1]!, draw[2]!, draw[3]!];
  return [a * 10 + b, b * 10 + c, c * 10 + d];
}

function computeCounts(map: DateDrawsMap, period: "m" | "e", mapSource: "p3" | "p4"): CountMap {
  const key = period === "m" ? "m" : "e";
  const minLen = mapSource === "p4" ? 4 : 3;
  const datesWithDraw = sortDateKeys(
    Object.keys(map).filter((dateStr) => {
      const draw = map[dateStr]?.[key];
      return draw != null && draw.length >= minLen;
    })
  );

  const count = new Map<number, Map<DayOfWeek, number>>();
  for (let n = 0; n < 100; n++) {
    const dayMap = new Map<DayOfWeek, number>();
    for (let d = 0; d <= 6; d++) dayMap.set(d as DayOfWeek, 0);
    count.set(n, dayMap);
  }

  const getNumbers = mapSource === "p4" ? twoDigitNumbersFromP4 : twoDigitNumbersFromP3;

  for (const dateStr of datesWithDraw) {
    const draw = map[dateStr]?.[key];
    if (!draw || draw.length < minLen) continue;
    const date = mmddyyToDate(dateStr);
    if (!date) continue;
    const dayOfWeek = date.getDay() as DayOfWeek;
    for (const num of getNumbers(draw)) {
      if (num >= 0 && num <= 99) count.get(num)!.set(dayOfWeek, (count.get(num)!.get(dayOfWeek) ?? 0) + 1);
    }
  }
  return count;
}

function getTop10PerDay(result: CountMap, day: DayOfWeek): { num: number; count: number }[] {
  const items: { num: number; count: number }[] = [];
  for (let n = 0; n < 100; n++) {
    const c = result.get(n)?.get(day) ?? 0;
    if (c > 0) items.push({ num: n, count: c });
  }
  items.sort((a, b) => b.count - a.count);
  return items.slice(0, 10);
}

function formatMessage(result: CountMap, mapSource: "p3" | "p4", period: "m" | "e"): string {
  const periodLabel = period === "m" ? "☀️ Mediodía (M)" : "🌙 Noche (E)";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";
  const fmtItem = (num: number, count: number) => `${String(num).padStart(2, "0")} (${count})`;
  const blocks: string[] = [
    `📊 *Conteo por día de la semana* — ${mapLabel} · ${periodLabel}`,
    "Top 10 números que más han salido en cada día — formato # (count)\n",
  ];
  const dayOrder: DayOfWeek[] = [1, 2, 3, 4, 5, 6, 0];
  for (const day of dayOrder) {
    const top10 = getTop10PerDay(result, day);
    blocks.push(`*${DAY_LABELS[day]}*`);
    if (top10.length === 0) blocks.push("_Sin datos_");
    else blocks.push("```", ...top10.map(({ num, count }) => fmtItem(num, count)), "```");
    blocks.push("");
  }
  const full = blocks.join("\n").trimEnd();
  return full.length > 4000 ? full.slice(0, 3990) + "\n\n_… (mensaje recortado)_" : full;
}

export const estrategiaTest: StrategyDefinition = {
  id: "estrategia_test",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,
  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const result = computeCounts(map, context.period, context.mapSource);
    return formatMessage(result, context.mapSource, context.period);
  },
};
