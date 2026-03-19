import type { HoyResult } from "./hoy-results.js";

export interface DateDrawsMap {
  [date: string]: {
    m?: number[];
    e?: number[];
  };
}

/** Formatea el número como "1-2-3" o "1-2-3-4" */
const formatDigits = (v: string | number[]) => {
  if (Array.isArray(v)) return v.join("-");
  if (typeof v === 'string') {
    // Si ya tiene guiones, dejarlo
    if (v.includes("-")) return v;
    // Si es una cadena pegada (ej: "123")
    if (v.length === 3 || v.length === 4) return v.split("").join("-");
  }
  return v;
};

export function buildRecentDrawsDisplay(
  p3Map: DateDrawsMap,
  p4Map: DateDrawsMap,
  today: string,
  yesterday: string,
  hoyData: HoyResult
): string {

  const resolveDraw = (source: "p3" | "p4", period: "m" | "e") => {
    const key = `${source}_${period}` as keyof HoyResult;
    const dateKey = `${source}_${period}_date` as keyof HoyResult;

    // 1. Manually Pushed / Saved Result
    if (hoyData[key]) {
      const date = hoyData[dateKey] || today;
      return { draw: formatDigits(hoyData[key] as string), date };
    }

    // 2. Fallback to Scraped PDF
    const map = source === "p3" ? p3Map : p4Map;
    if (map[today] && map[today][period]) {
      return { draw: formatDigits(map[today][period]!), date: today };
    }
    if (map[yesterday] && map[yesterday][period]) {
      return { draw: formatDigits(map[yesterday][period]!), date: yesterday };
    }

    return { draw: "---", date: "" };
  };

  const mP3 = resolveDraw("p3", "m");
  const eP3 = resolveDraw("p3", "e");
  const mP4 = resolveDraw("p4", "m");
  const eP4 = resolveDraw("p4", "e");

  const getSectionTag = (drawA: { date: string }, drawB: { date: string }) => {
    const d = drawA.date || drawB.date || today;
    return d === today ? "🟢 HOY" : `🟠 ${d} - AYER`;
  };

  const mediodiaTag = getSectionTag(mP3, mP4);
  const nocheTag = getSectionTag(eP3, eP4);

  return `\n` +
    `☀️ MEDIODÍA ${mediodiaTag}\n` +
    ` 🎯 Fijo (P3): ${mP3.draw}\n` +
    ` 🎲 Corrido (P4): ${mP4.draw}\n\n` +
    `🌙 NOCHE ${nocheTag}\n` +
    ` 🎯 Fijo (P3): ${eP3.draw}\n` +
    ` 🎲 Corrido (P4): ${eP4.draw}`;
}
