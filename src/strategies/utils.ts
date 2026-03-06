/**
 * Utilidades compartidas para estrategias: parsing de fechas, extracción de pares de dígitos
 * y ordenamiento cronológico de claves del mapa de conocimientos.
 */

import type { DateDrawsMap, StrategyContext, StrategyMapSource, StrategyPeriod } from "./types.js";

/** Convierte clave "MM/DD/YY" a Date. Retorna null si el formato es inválido. */
export function mmddyyToDate(key: string): Date | null {
  const m = key.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return null;
  const mm = parseInt(m[1]!, 10);
  const dd = parseInt(m[2]!, 10);
  let yy = parseInt(m[3]!, 10);
  yy = yy >= 50 ? 1900 + yy : 2000 + yy;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const d = new Date(yy, mm - 1, dd);
  if (d.getDate() !== dd || d.getMonth() !== mm - 1) return null;
  return d;
}

/** Ordena claves del mapa cronológicamente (más antiguo primero). */
export function sortDateKeys(keys: string[]): string[] {
  // Parsea cada fecha una sola vez (Schwartzian transform) en lugar de reparsear
  // en cada comparación del sort (que ocurre O(n log n) veces).
  return keys
    .map((k) => ({ k, t: mmddyyToDate(k)?.getTime() ?? 0 }))
    .sort((a, b) => a.t - b.t)
    .map((x) => x.k);
}

/**
 * Extrae pares de dígitos NO solapados de un sorteo:
 * - P3 [a,b,c]   → [bc]        (decena+unidad; la centena se analiza aparte con p3Centena)
 * - P4 [a,b,c,d] → [ab, cd]    (Par1=AB, Par2=CD; sin solaparse en el dígito central)
 */
export function twoDigitNumbers(draw: number[], mapSource: StrategyMapSource): number[] {
  if (mapSource === "p3") {
    if (draw.length < 3) return [];
    const [, b, c] = [draw[0]!, draw[1]!, draw[2]!];
    return [b! * 10 + c!];
  } else {
    if (draw.length < 4) return [];
    const [a, b, c, d] = [draw[0]!, draw[1]!, draw[2]!, draw[3]!];
    return [a * 10 + b, c * 10 + d];
  }
}

/**
 * Extrae la centena (primer dígito) de un sorteo P3.
 * Retorna null si el draw tiene menos de 3 dígitos.
 */
export function p3Centena(draw: number[]): number | null {
  return draw.length >= 3 ? draw[0]! : null;
}

/** Formatea una Date como "MM/DD/YY". */
export function dateToMMDDYY(date: Date): string {
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const yy = String(date.getFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}

/** Retorna las fechas del mapa que tienen sorteo válido para el período y fuente dados. */
export function validDateKeys(map: DateDrawsMap, period: StrategyPeriod, mapSource: StrategyMapSource): string[] {
  const minLen = mapSource === "p4" ? 4 : 3;
  return sortDateKeys(
    Object.keys(map).filter((d) => {
      const draw = map[d]?.[period];
      return draw != null && draw.length >= minLen;
    })
  );
}

/** Trunca un mensaje a 4000 caracteres si supera el límite de Telegram. */
export function truncateMsg(text: string): string {
  return text.length > 4000 ? text.slice(0, 3990) + "\n\n_… (recortado)_" : text;
}

/**
 * Retorna el rango de fechas del mapa como "MM/DD/YY – MM/DD/YY".
 * Útil para mostrar en cada salida de estrategia qué período de datos se usó.
 */
export function getDateRangeStr(
  map: DateDrawsMap,
  period: StrategyPeriod,
  mapSource: StrategyMapSource
): string {
  const dates = validDateKeys(map, period, mapSource);
  if (dates.length === 0) return "Sin datos";
  const from = dates[0]!;
  const to = dates[dates.length - 1]!;
  return from === to ? from : `${from} – ${to}`;
}

/**
 * Filtra un DateDrawsMap para incluir solo las fechas ≤ cutoffDateStr.
 * Útil para modo testing: simular el análisis como si solo se conociera
 * la historia hasta esa fecha.
 * Si la fecha de corte es inválida, retorna el mapa completo sin modificar.
 */
export function filterMapByCutoff(
  map: DateDrawsMap,
  cutoffDateStr: string
): DateDrawsMap {
  const cutoff = mmddyyToDate(cutoffDateStr);
  if (!cutoff) return map;
  const result: DateDrawsMap = {};
  for (const [key, value] of Object.entries(map)) {
    const d = mmddyyToDate(key);
    if (d && d <= cutoff) result[key] = value;
  }
  return result;
}

/**
 * Para P3: extrae los 3 dígitos del sorteo como [centena, decena, unidad].
 * Retorna null si el sorteo no tiene al menos 3 dígitos.
 */
export function p3Positions(draw: number[]): [number, number, number] | null {
  if (draw.length < 3) return null;
  return [draw[0]!, draw[1]!, draw[2]!];
}

/**
 * Para P4: divide el sorteo en 2 pares NO solapados → [AB, CD] como números 00-99.
 * Retorna null si el sorteo no tiene al menos 4 dígitos.
 */
export function p4Pairs(draw: number[]): [number, number] | null {
  if (draw.length < 4) return null;
  const ab = draw[0]! * 10 + draw[1]!;
  const cd = draw[2]! * 10 + draw[3]!;
  return [ab, cd];
}

export const DAY_NAMES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;
export const MONTH_NAMES = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
] as const;

/**
 * Encuentra el primer sorteo estrictamente posterior a cutoffDateStr en el mapa completo
 * (sin filtrar) para el período y fuente dados.
 * Útil en modo testing para obtener el resultado "oculto" al que apuntaban los candidatos.
 */
export function getNextDrawResult(
  fullMap: DateDrawsMap,
  cutoffDateStr: string,
  period: StrategyPeriod,
  mapSource: StrategyMapSource
): { date: string; numbers: number[] } | null {
  const cutoff = mmddyyToDate(cutoffDateStr);
  if (!cutoff) return null;
  const cutoffTime = cutoff.getTime();
  const minLen = mapSource === "p4" ? 4 : 3;
  // Parsea cada fecha una sola vez, filtra y ordena en una pasada
  const future = Object.keys(fullMap)
    .map((k) => ({ k, t: mmddyyToDate(k)?.getTime() ?? 0 }))
    .filter(({ k, t }) => {
      if (t <= cutoffTime) return false;
      const draw = fullMap[k]?.[period];
      return draw != null && draw.length >= minLen;
    })
    .sort((a, b) => a.t - b.t);
  if (future.length === 0) return null;
  const dateStr = future[0]!.k;
  return { date: dateStr, numbers: fullMap[dateStr]![period]! };
}

/**
 * Construye el bloque de verificación testing que se muestra solo al dueño.
 * Compara los candidatos predichos por la estrategia con el sorteo real siguiente
 * al corte y señala si alguno coincide.
 *
 * Los candidatos son números 00-99 (pares de dígitos). Para P3 [a,b,c] el
 * comparable es b*10+c; para P4 [a,b,c,d] son a*10+b y c*10+d.
 */
export function buildTestingVerificationBlock(
  nextResult: { date: string; numbers: number[] },
  candidates: number[],
  context: StrategyContext
): string {
  const { date, numbers } = nextResult;
  const d = mmddyyToDate(date);
  const dayLabel = d ? `${DAY_NAMES[d.getDay()]}, ${MONTH_NAMES[d.getMonth()]}` : "";
  const periodLabel = context.period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = context.mapSource === "p3" ? "P3" : "P4";

  const drawStr = numbers.join("-");
  const actuals = twoDigitNumbers(numbers, context.mapSource);

  const hitLines: string[] = [];
  for (const actual of actuals) {
    const pos = candidates.indexOf(actual);
    const numStr = String(actual).padStart(2, "0");
    if (pos >= 0) {
      hitLines.push(`✅ \`${numStr}\` presente en candidatos _(pos. #${pos + 1})_`);
    } else {
      hitLines.push(`❌ \`${numStr}\` no estaba en la lista de candidatos`);
    }
  }

  if (actuals.length === 0) {
    hitLines.push("_(sorteo sin dígitos comparables)_");
  }

  const lines: string[] = [
    "",
    "─────────────────────────────────────",
    `🧪 *Verificación Testing* — ${mapLabel} · ${periodLabel}`,
    `📅 Sorteo siguiente al corte: *${date}*${dayLabel ? ` (${dayLabel})` : ""}`,
    `🎰 Resultado real: \`${drawStr}\``,
    ...hitLines,
  ];

  if (candidates.length > 0) {
    const candStr = candidates.slice(0, 20).map((n) => String(n).padStart(2, "0")).join(" ");
    lines.push(`_Top candidatos: ${candStr}_`);
  }

  return lines.join("\n");
}
