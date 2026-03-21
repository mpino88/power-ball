import type { HoyResult } from "./hoy-results.js";

export interface DateDrawsMap {
  [date: string]: {
    m?: number[];
    e?: number[];
  };
}

export interface ResolvedDraw {
  draw: string; // Formato "X-X-X" o "X-X-X-X" o "---"
  date: string; // Fecha efectiva del dato (MM/DD/YY)
  label: string; // "🟢 HOY" o "🟠 MM/DD/YY - AYER"
  isFallback: boolean;
}

/** 
 * Formatea el número como "1-2-3" o "1-2-3-4". 
 * Es la base visual de la asimetría positiva en la lectura de resultados.
 */
export function formatDigits(v: string | number[] | undefined): string {
  if (!v) return "---";
  if (Array.isArray(v)) return v.join("-");
  if (typeof v === "string") {
    if (v.includes("-")) return v;
    if (v.length === 3 || v.length === 4) return v.split("").join("-");
  }
  return v;
}

/**
 * MOTOR DE RESOLUCIÓN ÚNICO (SST)
 * Decide qué sorteo mostrar basándose en la disponibilidad jerárquica:
 * 1. Manual push (hoyData)
 * 2. PDF Scraper Today
 * 3. FALLBACK: PDF Scraper Yesterday (Step-Down dinámico)
 */
export function resolveLatestDraw(
  source: "p3" | "p4",
  period: "m" | "e",
  maps: { p3: DateDrawsMap; p4: DateDrawsMap },
  dates: { today: string; yesterday: string },
  hoyData: HoyResult
): ResolvedDraw {
  const key = `${source}_${period}` as keyof HoyResult;
  const dateKey = `${source}_${period}_date` as keyof HoyResult;

  // 1. Prioridad Máxima: Push Manual (Hoy o reciente)
  if (hoyData[key]) {
    const d = (hoyData[dateKey] as string) || dates.today;
    return {
      draw: formatDigits(hoyData[key] as string),
      date: d,
      label: d === dates.today ? "🟢 HOY" : `🟠 ${d} - AYER`,
      isFallback: d !== dates.today,
    };
  }

  // 2. Prioridad Media: Raspado PDF para HOY
  const map = source === "p3" ? maps.p3 : maps.p4;
  if (map[dates.today] && map[dates.today][period]) {
    return {
      draw: formatDigits(map[dates.today][period]!),
      date: dates.today,
      label: "🟢 HOY",
      isFallback: false,
    };
  }

  // 3. FALLBACK DINÁMICO: Raspado PDF para AYER (Sorteo no ocurrido aún hoy)
  if (map[dates.yesterday] && map[dates.yesterday][period]) {
    return {
      draw: formatDigits(map[dates.yesterday][period]!),
      date: dates.yesterday,
      label: `🟠 ${dates.yesterday} - AYER`,
      isFallback: true,
    };
  }

  // 4. Vacío Total (Sin datos en 48h)
  return {
    draw: "---",
    date: dates.today,
    label: "🟢 HOY", // Mostramos Hoy indicando que no hay datos aún
    isFallback: false,
  };
}
