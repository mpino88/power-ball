import type { HoyResult } from "./hoy-results.js";

export interface DateDrawsMap {
  [date: string]: {
    m?: number[];
    e?: number[];
  };
}

/** Formatea el número como "0-3-6" */
const formatDigits = (v: string | number[]) => {
  if (Array.isArray(v)) return v.join("-");
  if (v.length === 3 || v.length === 4) return v.split("").join("-");
  return v;
};

export function buildRecentDrawsDisplay(
  p3Map: DateDrawsMap,
  p4Map: DateDrawsMap,
  today: string,
  yesterday: string,
  hoyData: HoyResult
): string {
  // Encontrar el mejor dato para cada slot. Prioridad 1: hoyData. Prioridad 2: Map PDF (today -> yesterday)
  
  const resolveDraw = (source: "p3"|"p4", period: "m"|"e") => {
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
    
    return { draw: "N/A", date: "" };
  };

  const mP3 = resolveDraw("p3", "m");
  const eP3 = resolveDraw("p3", "e");
  const mP4 = resolveDraw("p4", "m");
  const eP4 = resolveDraw("p4", "e");

  const fmtLabel = (res: { draw: string, date: string }) => {
    if (res.draw === "N/A") return "❌ _Pendiente_";
    const isToday = res.date === today;
    const timeTag = isToday 
      ? `🟢 *[HOY]*` 
      : `⚪ *[AYER - ${res.date}]*`;
    return `*${res.draw}*  ${timeTag}`;
  };

  return `📊 *TERMINAL DE RESULTADOS* 🎰\n\n` +
    `☀️ *MEDIODÍA*\n` +
    ` 🎯 Pick3: ${fmtLabel(mP3)}\n` +
    ` 🎲 Pick4: ${fmtLabel(mP4)}\n\n` +
    `🌙 *NOCHE*\n` +
    ` 🎯 Pick3: ${fmtLabel(eP3)}\n` +
    ` 🎲 Pick4: ${fmtLabel(eP4)}`;
}
