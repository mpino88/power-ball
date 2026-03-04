/**
 * Más salidores x día de la semana: top 10 números (00-99) por cada día.
 * Id: max_per_week_day. Título/descripción se persisten en la 2ª pestaña del Sheet.
 * Un solo mensaje en formato tabla (estilo dashboard estadísticas).
 */

import type { StrategyContext, StrategyDefinition } from "./types.js";
import type { DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";

/** Día de la semana: 0=Dom, 1=Lun, …, 6=Sáb. */
type DayOfWeek = 0 | 1 | 2 | 3 | 4 | 5 | 6;

type CountMap = Map<number, Map<DayOfWeek, number>>;

const DAY_HEADERS = ["L", "Ma", "Mi", "J", "V", "S", "D"] as const; /* Lun, Mar, Mié, Jue, Vie, Sáb, Dom */
const DAY_ORDER: DayOfWeek[] = [1, 2, 3, 4, 5, 6, 0];

/** Bloques para mejorar legibilidad: [L,Ma,Mi], [J], [V,S,D]. */
const DAY_BLOCKS: DayOfWeek[][] = [[1, 2, 3], [4], [5, 6, 0]];
const W_CELL = 10;

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

/** Top 10 por día. */
function getTop10PerDay(result: CountMap, day: DayOfWeek): { num: number; count: number }[] {
  const items: { num: number; count: number }[] = [];
  for (let n = 0; n < 100; n++) {
    const c = result.get(n)?.get(day) ?? 0;
    if (c > 0) items.push({ num: n, count: c });
  }
  items.sort((a, b) => b.count - a.count);
  return items.slice(0, 10);
}

/** Un solo mensaje con bloques separados: L Ma Mi | J | V S D para distinguir bien la data. */
function formatMessage(result: CountMap, mapSource: "p3" | "p4", period: "m" | "e"): string {
  const periodLabel = period === "m" ? "☀️ Mediodía (M)" : "🌙 Noche (E)";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  const cell = (num: number, count: number) => `${String(num).padStart(2, "0")}(${count})`.padEnd(W_CELL);

  const lines: string[] = [
    `📊 *Más salidores x día de la semana* — ${mapLabel} · ${periodLabel}`,
    "",
    "📖 _Qué mide:_ los 10 números \\(00\\-99\\) que más han salido en cada día de la semana\\.",
    "Formato _##\\(n\\)_ = número y veces que salió ese día · L=Lun · Ma=Mar · Mi=Mié · J=Jue · V=Vie · S=Sáb · D=Dom",
    "→ Enfócate en la columna del día que corresponde al PRÓXIMO sorteo estimado",
    "",
    "```",
    "Top 10 por día (formato #(count))",
  ];

  const dayToHeader: Record<DayOfWeek, string> = { 0: "D", 1: "L", 2: "Ma", 3: "Mi", 4: "J", 5: "V", 6: "S" };
  for (const block of DAY_BLOCKS) {
    const headers = block.map((d) => dayToHeader[d].padEnd(W_CELL)).join(" ");
    const sep = "─".repeat(block.length * (W_CELL + 1) - 1);
    lines.push(headers);
    lines.push(sep);
    for (let row = 0; row < 10; row++) {
      const cells: string[] = [];
      for (const day of block) {
        const top10 = getTop10PerDay(result, day);
        const item = top10[row];
        cells.push(item ? cell(item.num, item.count) : "".padEnd(W_CELL));
      }
      lines.push(cells.join(" "));
    }
    lines.push("");
  }

  lines.push("```");
  const full = lines.join("\n").trimEnd();
  return full.length > 4000 ? full.slice(0, 3990) + "\n\n_… (mensaje recortado)_" : full;
}

export const maxPerWeekDay: StrategyDefinition = {
  id: "max_per_week_day",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,
  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const result = computeCounts(map, context.period, context.mapSource);
    return formatMessage(result, context.mapSource, context.period);
  },
  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    const counts = computeCounts(map, context.period, context.mapSource);
    const key = context.period === "m" ? "m" : "e";
    const minLen = context.mapSource === "p4" ? 4 : 3;
    const sortedDates = sortDateKeys(
      Object.keys(map).filter((d) => {
        const draw = map[d]?.[key];
        return draw != null && draw.length >= minLen;
      })
    );
    const latestKey = sortedDates.at(-1);
    const latestDate = latestKey ? mmddyyToDate(latestKey) : null;
    const nextDate = latestDate ? new Date(latestDate.getTime() + 86_400_000) : new Date();
    const targetDay = nextDate.getDay() as DayOfWeek;
    return getTop10PerDay(counts, targetDay).map((item) => item.num);
  },
};
