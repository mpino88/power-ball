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
 * MOTOR DE RESOLUCIÓN ÚNICO — PostgreSQL como Única Fuente de Verdad
 *
 * Obtiene el sorteo más reciente disponible en los mapas cargados desde DB.
 * El parámetro `hoyData` se mantiene por compatibilidad con llamadas existentes
 * pero ya NO se usa — la BD es siempre la fuente definitiva.
 *
 * Jerarquía:
 *  1. Dato más reciente en maps (cargados desde PostgreSQL)
 *  2. Si no hay dato → vacío ("---")
 */
export function resolveLatestDraw(
  source: "p3" | "p4",
  period: "m" | "e",
  maps: { p3: DateDrawsMap; p4: DateDrawsMap },
  dates: { today: string; yesterday: string },
  _hoyData?: HoyResult  // ignorado — DB es la fuente de verdad
): ResolvedDraw {
  const map = source === "p3" ? maps.p3 : maps.p4;

  // Filtrar fechas que tengan datos para el período pedido
  const availableDates = Object.keys(map).filter(
    (date) => map[date] !== undefined && map[date][period] !== undefined && map[date][period]!.length > 0
  );

  // Ordenar cronológicamente descendente (más reciente primero)
  availableDates.sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

  const latestDate = availableDates[0];

  if (latestDate) {
    const isToday = latestDate === dates.today;
    return {
      draw: formatDigits(map[latestDate][period]!),
      date: latestDate,
      label: isToday ? "🟢 HOY" : `🟠 ${latestDate} - AYER`,
      isFallback: !isToday,
    };
  }

  // Sin datos en toda la base de datos
  return {
    draw: "---",
    date: dates.today,
    label: "🟢 HOY",
    isFallback: false,
  };
}
