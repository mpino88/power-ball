/**
 * Análisis Progresivo — Back-testing iterativo con todas las combinaciones posibles.
 *
 * Para cada fecha de corte D (ordenada de más antigua a más reciente):
 *   1. Construye la base de conocimientos acumulada hasta D (incremental).
 *   2. Extrae candidatos de cada estrategia (una vez por fecha, en paralelo).
 *   3. Evalúa las 2^N − 1 combinaciones posibles usando bitmask.
 *   4. Verifica si el sorteo real siguiente está en el top-N de cada combo.
 *
 * Por cada combo, además del hit rate, se detectan PATRONES DE CERTEZA Y FALLO:
 *
 *   · Racha pre-acierto   — ¿cuántos fallos consecutivos preceden a cada hit?
 *                           Media y std (Welford online). Índica cuándo "activar".
 *   · Transición H/C      — P(hit | prev=hit)  vs  P(hit | prev=miss)
 *                           Revela si los aciertos se agrupan o se distribuyen.
 *   · Histograma de intervalos (10 buckets de 5 sorteos)
 *                           → banda pico (donde se concentran los hits)
 *                           → p25 y p75 (ventana óptima de juego)
 *   · Tendencia reciente   — hit rate en los últimos ~50 sorteos vs global.
 *                           Detecta combos en alza o en declive.
 *   · Mejor día / mes      — hit rate por día de la semana y por mes del sorteo.
 *   · Intervalo medio ± σ  — distancia media entre aciertos consecutivos.
 *
 * Todo se calcula inline durante el loop principal (sin pasadas extra), usando
 * typed arrays planos para mínima asignación y máximo rendimiento de caché.
 *
 * Memoria adicional para N=8 (255 combos): ~50 KB
 *                      N=15 (32767 combos): ~5 MB
 */

import { InlineKeyboard } from "grammy";
import type { DateDrawsMap, StrategyContext, StrategyDefinition } from "./types.js";
import { twoDigitNumbers, mmddyyToDate } from "./utils.js";
import { CONSENSUS_GROUPS } from "./consensus-multi.js";

// ── Constantes ────────────────────────────────────────────────────────────────

export const PROGRESSIVE_TOP_N = 10;
export const PROGRESSIVE_MAX_DATES = 2500;
export const PROGRESSIVE_WARN_THRESHOLD = 400;
export const PROGRESSIVE_MAX_STRATEGIES = 15;

const TOP_COMBOS_DISPLAY = 10;
/** Ventana de "tendencia reciente" en sorteos. */
const RECENT_WINDOW = 50;

const DOW_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;
const MONTH_LABELS = [
  "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
] as const;

/**
 * 10 buckets de intervalo (sorteos entre aciertos consecutivos):
 * [1-5, 6-10, 11-15, 16-20, 21-25, 26-30, 31-35, 36-40, 41-45, 46+]
 */
const INTERVAL_BUCKETS = 10;
const BUCKET_WIDTH = 5;
const BUCKET_LABELS = ["1-5", "6-10", "11-15", "16-20", "21-25",
                       "26-30", "31-35", "36-40", "41-45", "46+"] as const;
const BUCKET_MIDPOINTS = [3, 8, 13, 18, 23, 28, 33, 38, 43, 48];

function intervalBucket(interval: number): number {
  const b = Math.floor((interval - 1) / BUCKET_WIDTH);
  return Math.min(b, INTERVAL_BUCKETS - 1);
}

// ── Tipos ─────────────────────────────────────────────────────────────────────

/**
 * Condiciones detectadas estadísticamente para una combinación de estrategias.
 * Cada campo responde una pregunta de acción concreta.
 */
export interface SubsetConditions {
  // ── ¿En qué día/mes tiene mejor desempeño? ────────────────────────────────
  bestDows: Array<{ label: string; hitRate: number }>;
  bestMonths: Array<{ label: string; hitRate: number }>;

  // ── ¿Cada cuánto acierta? ─────────────────────────────────────────────────
  /** Media y desviación del intervalo entre aciertos consecutivos. */
  avgInterval: number;
  stdInterval: number;
  /** Banda donde se concentra el mayor número de hits (bucket pico). */
  peakBand: string;
  /** Cuartil 25 de intervalos (la "ventana de juego" empieza aquí). */
  p25: number;
  /** Cuartil 75 de intervalos (la "ventana de juego" termina aquí). */
  p75: number;

  // ── ¿Cuántos fallos esperar antes de jugar? ──────────────────────────────
  /** Media de fallos consecutivos que preceden a cada acierto. */
  avgPreMiss: number;
  /** Desviación estándar de la racha de fallos pre-acierto. */
  stdPreMiss: number;

  // ── ¿Se agrupan los aciertos o se distribuyen? ───────────────────────────
  /** Hit rate cuando el sorteo anterior también fue acierto. */
  hitAfterHit: number;
  /** Hit rate cuando el sorteo anterior fue fallo. */
  hitAfterMiss: number;

  // ── ¿Sigue vigente? ───────────────────────────────────────────────────────
  /** Hit rate en los últimos RECENT_WINDOW sorteos. −1 si no hay suficientes datos. */
  recentHitRate: number;
  /** Diferencia (pp) respecto al hit rate global. Positivo = mejorando. */
  recentDelta: number;
  trend: "up" | "down" | "stable";
}

export interface ProgressiveSubset {
  indices: number[];
  label: string;
  hits: number;
  misses: number;
  skipped: number;
  hitRate: number;
  conditions?: SubsetConditions;
}

export interface ProgressiveResult {
  topSubsets: ProgressiveSubset[];
  bestBySize: ProgressiveSubset[];
  totalSubsets: number;
  context: StrategyContext;
  startDate: string;
  endDate: string;
  datesAnalyzed: number;
  totalInRange: number;
  topN: number;
  strategyCount: number;
}

export interface ProgressiveSession {
  step: "context" | "start_date" | "end_date" | "strategies" | "confirm";
  context?: StrategyContext;
  startDate?: string;
  endDate?: string;
  selectedIds: Set<string>;
  estimatedDates?: number;
}

export interface ProgressiveParams {
  startDate: string;
  endDate: string;
  strategyIds: string[];
  context: StrategyContext;
  topN: number;
  fullMap: DateDrawsMap;
  getStrategy: (id: string) => StrategyDefinition | undefined;
  onProgress?: (pct: number) => Promise<void>;
}

// ── Metadatos de subsets (precalculados una vez antes del loop) ───────────────

interface SubsetMeta {
  indices: readonly number[];
  label: string;
  size: number;
}

function buildSubsetMeta(n: number): SubsetMeta[] {
  const total = (1 << n) - 1;
  const meta: SubsetMeta[] = new Array(total);
  for (let mask = 1; mask <= total; mask++) {
    const indices: number[] = [];
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) {
        indices.push(i);
        parts.push(String.fromCharCode(65 + i));
      }
    }
    meta[mask - 1] = { indices, label: parts.join("+"), size: indices.length };
  }
  return meta;
}

/** Estima el número de fechas válidas en un rango (para confirmación previa). */
export function countDatesInRange(
  fullMap: DateDrawsMap,
  startDate: string,
  endDate: string,
  context: StrategyContext
): number {
  const startDt = mmddyyToDate(startDate);
  const endDt = mmddyyToDate(endDate);
  if (!startDt || !endDt) return 0;
  const startTime = startDt.getTime();
  const endTime = endDt.getTime();
  const minLen = context.mapSource === "p4" ? 4 : 3;
  return Object.keys(fullMap).filter((k) => {
    const t = mmddyyToDate(k)?.getTime() ?? 0;
    if (t < startTime || t > endTime) return false;
    const draw = fullMap[k]?.[context.period];
    return draw != null && draw.length >= minLen;
  }).length;
}

// ── Motor principal ───────────────────────────────────────────────────────────

export async function runProgressiveAnalysis(
  params: ProgressiveParams
): Promise<ProgressiveResult> {
  const { startDate, endDate, strategyIds, context, topN, fullMap, getStrategy, onProgress } =
    params;

  const n = Math.min(strategyIds.length, PROGRESSIVE_MAX_STRATEGIES);
  const effectiveIds = strategyIds.slice(0, n);

  const startDt = mmddyyToDate(startDate);
  const endDt = mmddyyToDate(endDate);
  if (!startDt || !endDt || startDt > endDt) throw new Error("Rango de fechas inválido");

  const startTime = startDt.getTime();
  const endTime = endDt.getTime();
  const minLen = context.mapSource === "p4" ? 4 : 3;

  // ── 1. Parsear timestamps UNA SOLA VEZ ────────────────────────────────────
  const keyTimeArr = Object.keys(fullMap).map((k) => ({
    k,
    t: mmddyyToDate(k)?.getTime() ?? 0,
  }));
  keyTimeArr.sort((a, b) => a.t - b.t);
  const allMapKeys = keyTimeArr.map((x) => x.k);
  const keyTime = new Map<string, number>(keyTimeArr.map((x) => [x.k, x.t]));

  // ── 2. Fechas válidas ordenadas ───────────────────────────────────────────
  const allValidDates = allMapKeys.filter((d) => {
    const draw = fullMap[d]?.[context.period];
    return draw != null && draw.length >= minLen;
  });
  const validIdx = new Map<string, number>(allValidDates.map((d, i) => [d, i]));

  // ── 3. Fechas de corte ─────────────────────────────────────────────────────
  const datesInRange = allValidDates.filter((d) => {
    const t = keyTime.get(d)!;
    return t >= startTime && t <= endTime;
  });
  const totalInRange = datesInRange.length;
  const cutoffDates = datesInRange.slice(0, PROGRESSIVE_MAX_DATES);
  const totalDates = cutoffDates.length;

  // ── 4. Metadatos de subsets ────────────────────────────────────────────────
  const totalSubsets = (1 << n) - 1;
  const subsetMeta = buildSubsetMeta(n);

  // ── 5. Typed arrays de contadores ─────────────────────────────────────────
  // Core
  const hitsArr    = new Uint32Array(totalSubsets);
  const missesArr  = new Uint32Array(totalSubsets);
  const skippedArr = new Uint32Array(totalSubsets);

  // Día / mes del sorteo objetivo
  const hitsByDow   = new Uint16Array(totalSubsets * 7);
  const totByDow    = new Uint16Array(totalSubsets * 7);
  const hitsByMonth = new Uint16Array(totalSubsets * 12);
  const totByMonth  = new Uint16Array(totalSubsets * 12);

  // Intervalo entre aciertos (Welford)
  const lastHitIdx   = new Int32Array(totalSubsets).fill(-1);
  const intervalCnt  = new Uint16Array(totalSubsets);
  const intervalMean = new Float64Array(totalSubsets);
  const intervalM2   = new Float64Array(totalSubsets);

  // Histograma de intervalos (10 buckets × 5 sorteos)
  const intervalBuckets = new Uint16Array(totalSubsets * INTERVAL_BUCKETS);

  // Racha de fallos antes de cada acierto (Welford)
  const currentMissStreak  = new Uint16Array(totalSubsets);
  const preMissCnt         = new Uint16Array(totalSubsets);
  const preMissMean        = new Float64Array(totalSubsets);
  const preMissM2          = new Float64Array(totalSubsets);

  // Transición caliente / fría
  // prevState: 0=nunca jugado, 1=prev hit, 2=prev miss
  const prevState      = new Uint8Array(totalSubsets);
  const hitsAfterHit   = new Uint16Array(totalSubsets);
  const totAfterHit    = new Uint16Array(totalSubsets);
  const hitsAfterMiss  = new Uint16Array(totalSubsets);
  const totAfterMiss   = new Uint16Array(totalSubsets);

  // Tendencia reciente (últimos RECENT_WINDOW sorteos no-skipped)
  const recentHits  = new Uint16Array(totalSubsets);
  const recentTotal = new Uint16Array(totalSubsets);
  // "fecha de inicio de la ventana reciente" como índice
  const recentStart = Math.max(0, totalDates - RECENT_WINDOW);

  // ── 6. Mapa filtrado INCREMENTAL ─────────────────────────────────────────
  const filteredMap: DateDrawsMap = {};
  let mapPtr = 0;
  while (mapPtr < allMapKeys.length && keyTime.get(allMapKeys[mapPtr]!)! < startTime) {
    filteredMap[allMapKeys[mapPtr]!] = fullMap[allMapKeys[mapPtr]!]!;
    mapPtr++;
  }

  // ── Buffers reutilizables para votos ──────────────────────────────────────
  const voteCounts = new Int32Array(100);
  const usedNums: number[] = [];

  // ── Loop principal ────────────────────────────────────────────────────────
  let lastReportedPct = -1;

  for (let dateIdx = 0; dateIdx < cutoffDates.length; dateIdx++) {
    const cutoffDate = cutoffDates[dateIdx]!;
    const cutoffTime = keyTime.get(cutoffDate)!;
    const isRecent = dateIdx >= recentStart;

    // Avance incremental del mapa filtrado
    while (mapPtr < allMapKeys.length && keyTime.get(allMapKeys[mapPtr]!)! <= cutoffTime) {
      filteredMap[allMapKeys[mapPtr]!] = fullMap[allMapKeys[mapPtr]!]!;
      mapPtr++;
    }

    // Siguiente sorteo real
    const nextDateStr = allValidDates[validIdx.get(cutoffDate)! + 1];
    if (!nextDateStr) {
      for (let i = 0; i < totalSubsets; i++) skippedArr[i]++;
      if (onProgress && totalDates > 0) {
        const pct = Math.floor(((dateIdx + 1) / totalDates) * 100);
        if (pct >= lastReportedPct + 10) { lastReportedPct = pct; await onProgress(pct); }
      }
      continue;
    }

    const nextDraw = fullMap[nextDateStr]?.[context.period];
    if (!nextDraw || nextDraw.length < minLen) {
      for (let i = 0; i < totalSubsets; i++) skippedArr[i]++;
      if (onProgress && totalDates > 0) {
        const pct = Math.floor(((dateIdx + 1) / totalDates) * 100);
        if (pct >= lastReportedPct + 10) { lastReportedPct = pct; await onProgress(pct); }
      }
      continue;
    }

    const actuals = twoDigitNumbers(nextDraw, context.mapSource);
    if (actuals.length === 0) {
      for (let i = 0; i < totalSubsets; i++) skippedArr[i]++;
      if (onProgress && totalDates > 0) {
        const pct = Math.floor(((dateIdx + 1) / totalDates) * 100);
        if (pct >= lastReportedPct + 10) { lastReportedPct = pct; await onProgress(pct); }
      }
      continue;
    }

    // día/mes del SORTEO OBJETIVO (una vez por fecha, O(1))
    const nextDt    = mmddyyToDate(nextDateStr);
    const nextDow   = nextDt ? nextDt.getDay()    : -1;
    const nextMonth = nextDt ? nextDt.getMonth()  : -1;

    // Candidatos de todas las estrategias en paralelo
    const strategyCandidates = await Promise.all(
      effectiveIds.map(async (id) => {
        const strat = getStrategy(id);
        if (!strat?.getCandidates) return null;
        try { return await strat.getCandidates(context, filteredMap); } catch { return null; }
      })
    );

    const actualsSet = new Set(actuals);

    // ── Loop de subsets ────────────────────────────────────────────────────
    for (let maskIdx = 0; maskIdx < totalSubsets; maskIdx++) {
      const meta = subsetMeta[maskIdx]!;
      usedNums.length = 0;

      for (const idx of meta.indices) {
        const cands = strategyCandidates[idx];
        if (!cands) continue;
        for (const num of cands) {
          if (voteCounts[num] === 0) usedNums.push(num);
          voteCounts[num]++;
        }
      }

      if (usedNums.length === 0) {
        skippedArr[maskIdx]++;
        // Reset votes
        for (const num of usedNums) voteCounts[num] = 0;
        continue;
      }

      usedNums.sort((a, b) => voteCounts[b]! - voteCounts[a]!);

      let isHit = false;
      const limit = Math.min(topN, usedNums.length);
      for (let j = 0; j < limit && !isHit; j++) {
        if (actualsSet.has(usedNums[j]!)) isHit = true;
      }

      // Reset votes (parcial, O(usedNums))
      for (const num of usedNums) voteCounts[num] = 0;

      if (isHit) {
        hitsArr[maskIdx]++;

        // ── Día / mes ────────────────────────────────────────────────────
        if (nextDow >= 0) {
          hitsByDow[maskIdx * 7 + nextDow]++;
          totByDow[maskIdx * 7 + nextDow]++;
        }
        if (nextMonth >= 0) {
          hitsByMonth[maskIdx * 12 + nextMonth]++;
          totByMonth[maskIdx * 12 + nextMonth]++;
        }

        // ── Intervalo + histograma (Welford) ─────────────────────────────
        if (lastHitIdx[maskIdx] >= 0) {
          const interval = dateIdx - lastHitIdx[maskIdx];
          const cnt = ++intervalCnt[maskIdx];
          const delta = interval - intervalMean[maskIdx];
          intervalMean[maskIdx] += delta / cnt;
          intervalM2[maskIdx] += delta * (interval - intervalMean[maskIdx]);
          intervalBuckets[maskIdx * INTERVAL_BUCKETS + intervalBucket(interval)]++;
        }
        lastHitIdx[maskIdx] = dateIdx;

        // ── Racha pre-acierto (Welford) ───────────────────────────────────
        {
          const streak = currentMissStreak[maskIdx];
          const cnt = ++preMissCnt[maskIdx];
          const delta = streak - preMissMean[maskIdx];
          preMissMean[maskIdx] += delta / cnt;
          preMissM2[maskIdx] += delta * (streak - preMissMean[maskIdx]);
          currentMissStreak[maskIdx] = 0;
        }

        // ── Transición caliente/fría ──────────────────────────────────────
        const ps = prevState[maskIdx];
        if (ps === 1) { hitsAfterHit[maskIdx]++; totAfterHit[maskIdx]++; }
        else if (ps === 2) { hitsAfterMiss[maskIdx]++; totAfterMiss[maskIdx]++; }
        prevState[maskIdx] = 1;

        // ── Tendencia reciente ────────────────────────────────────────────
        if (isRecent) { recentHits[maskIdx]++; recentTotal[maskIdx]++; }

      } else {
        missesArr[maskIdx]++;
        currentMissStreak[maskIdx]++;

        // Totales día/mes para no-aciertos también (para hit rate relativo)
        if (nextDow >= 0) totByDow[maskIdx * 7 + nextDow]++;
        if (nextMonth >= 0) totByMonth[maskIdx * 12 + nextMonth]++;

        // Transición
        const ps = prevState[maskIdx];
        if (ps === 1) totAfterHit[maskIdx]++;
        else if (ps === 2) totAfterMiss[maskIdx]++;
        prevState[maskIdx] = 2;

        if (isRecent) recentTotal[maskIdx]++;
      }
    }

    if (onProgress && totalDates > 0) {
      const pct = Math.floor(((dateIdx + 1) / totalDates) * 100);
      if (pct >= lastReportedPct + 10) { lastReportedPct = pct; await onProgress(pct); }
    }
  }

  // ── Construir SubsetConditions desde los arrays acumulados ────────────────
  const buildConditions = (i: number, overallHitRate: number): SubsetConditions => {
    // Día de la semana
    const dowRates: Array<{ label: string; hitRate: number }> = [];
    for (let d = 0; d < 7; d++) {
      const tot = totByDow[i * 7 + d];
      if (tot >= 3) dowRates.push({ label: DOW_LABELS[d]!, hitRate: hitsByDow[i * 7 + d]! / tot });
    }
    dowRates.sort((a, b) => b.hitRate - a.hitRate);
    const bestDows = dowRates.slice(0, 2);

    // Mes
    const monthRates: Array<{ label: string; hitRate: number }> = [];
    for (let m = 0; m < 12; m++) {
      const tot = totByMonth[i * 12 + m];
      if (tot >= 2) monthRates.push({ label: MONTH_LABELS[m]!, hitRate: hitsByMonth[i * 12 + m]! / tot });
    }
    monthRates.sort((a, b) => b.hitRate - a.hitRate);
    const bestMonths = monthRates.slice(0, 2);

    // Intervalo medio ± σ
    const iCnt = intervalCnt[i]!;
    const avgInterval = iCnt > 0 ? Math.round(intervalMean[i]!) : 0;
    const stdInterval = iCnt >= 2 ? Math.round(Math.sqrt(intervalM2[i]! / iCnt)) : 0;

    // Histograma → banda pico + p25/p75
    let peakBand = "";
    let peakCount = 0;
    let totalIntervals = 0;
    for (let b = 0; b < INTERVAL_BUCKETS; b++) {
      const c = intervalBuckets[i * INTERVAL_BUCKETS + b]!;
      totalIntervals += c;
      if (c > peakCount) { peakCount = c; peakBand = BUCKET_LABELS[b]!; }
    }
    let p25 = 0, p75 = 0;
    if (totalIntervals > 0) {
      let cumul = 0;
      let p25Set = false;
      for (let b = 0; b < INTERVAL_BUCKETS; b++) {
        cumul += intervalBuckets[i * INTERVAL_BUCKETS + b]!;
        if (!p25Set && cumul >= totalIntervals * 0.25) { p25 = BUCKET_MIDPOINTS[b]!; p25Set = true; }
        if (cumul >= totalIntervals * 0.75) { p75 = BUCKET_MIDPOINTS[b]!; break; }
      }
    }

    // Racha pre-acierto
    const pmCnt = preMissCnt[i]!;
    const avgPreMiss = pmCnt > 0 ? Math.round(preMissMean[i]!) : 0;
    const stdPreMiss = pmCnt >= 2 ? Math.round(Math.sqrt(preMissM2[i]! / pmCnt)) : 0;

    // Transición H/C
    const tAH = totAfterHit[i]!;
    const tAM = totAfterMiss[i]!;
    const hitAfterHit  = tAH > 0 ? hitsAfterHit[i]!  / tAH : -1;
    const hitAfterMiss = tAM > 0 ? hitsAfterMiss[i]! / tAM : -1;

    // Tendencia reciente
    const rTot = recentTotal[i]!;
    const recentHitRate = rTot >= 10 ? recentHits[i]! / rTot : -1;
    const recentDelta = recentHitRate >= 0 ? (recentHitRate - overallHitRate) * 100 : 0;
    const trend: "up" | "down" | "stable" =
      recentHitRate < 0 ? "stable" :
      recentDelta >= 3  ? "up" :
      recentDelta <= -3 ? "down" : "stable";

    return {
      bestDows, bestMonths,
      avgInterval, stdInterval,
      peakBand, p25, p75,
      avgPreMiss, stdPreMiss,
      hitAfterHit, hitAfterMiss,
      recentHitRate, recentDelta, trend,
    };
  };

  // ── Ranking ───────────────────────────────────────────────────────────────
  const rankOrder: number[] = [];
  for (let i = 0; i < totalSubsets; i++) {
    if (hitsArr[i]! + missesArr[i]! > 0) rankOrder.push(i);
  }
  rankOrder.sort((a, b) => {
    const totA = hitsArr[a]! + missesArr[a]!;
    const totB = hitsArr[b]! + missesArr[b]!;
    return hitsArr[b]! / totB - hitsArr[a]! / totA;
  });

  const makeSubset = (i: number, withConditions: boolean): ProgressiveSubset => {
    const meta = subsetMeta[i]!;
    const tot = hitsArr[i]! + missesArr[i]!;
    const hitRate = tot > 0 ? hitsArr[i]! / tot : 0;
    return {
      indices: [...meta.indices],
      label: meta.label,
      hits: hitsArr[i]!,
      misses: missesArr[i]!,
      skipped: skippedArr[i]!,
      hitRate,
      conditions: withConditions ? buildConditions(i, hitRate) : undefined,
    };
  };

  const topSubsets = rankOrder.slice(0, TOP_COMBOS_DISPLAY).map((i) => makeSubset(i, true));

  const bestBySize: ProgressiveSubset[] = [];
  for (let size = 1; size <= n; size++) {
    const best = rankOrder.find((i) => subsetMeta[i]!.size === size);
    if (best !== undefined) bestBySize.push(makeSubset(best, true));
  }

  return {
    topSubsets, bestBySize, totalSubsets,
    context, startDate, endDate,
    datesAnalyzed: cutoffDates.length,
    totalInRange, topN,
    strategyCount: n,
  };
}

// ── Formato de condiciones ────────────────────────────────────────────────────

/**
 * Convierte SubsetConditions en 2-3 líneas compactas y accionables.
 * Cada línea responde una pregunta diferente de acción.
 */
function formatConditions(c: SubsetConditions, overallHitRate: number): string[] {
  const lines: string[] = [];
  const threshold = overallHitRate * 1.2;

  // Línea 1: Cuándo jugar (día/mes)
  const l1Parts: string[] = [];
  const topDows = c.bestDows.length > 0
    ? (c.bestDows.filter((d) => d.hitRate >= threshold).slice(0, 2).length > 0
        ? c.bestDows.filter((d) => d.hitRate >= threshold).slice(0, 2)
        : c.bestDows.slice(0, 1))
    : [];
  if (topDows.length > 0)
    l1Parts.push(`📅 ${topDows.map((d) => `${d.label}(${(d.hitRate * 100).toFixed(0)}%)`).join("·")}`);

  const topMonths = c.bestMonths.length > 0
    ? (c.bestMonths.filter((m) => m.hitRate >= threshold).slice(0, 2).length > 0
        ? c.bestMonths.filter((m) => m.hitRate >= threshold).slice(0, 2)
        : c.bestMonths.slice(0, 1))
    : [];
  if (topMonths.length > 0)
    l1Parts.push(`📆 ${topMonths.map((m) => `${m.label}(${(m.hitRate * 100).toFixed(0)}%)`).join("·")}`);

  if (l1Parts.length > 0) lines.push(`    ${l1Parts.join("  ")}`);

  // Línea 2: Cuándo activar (intervalo + racha de fallos)
  const l2Parts: string[] = [];
  if (c.peakBand) {
    const bandStr = c.p25 > 0 && c.p75 > 0 && c.p25 !== c.p75
      ? `ventana ${c.p25}-${c.p75} (pico ${c.peakBand})`
      : `pico ${c.peakBand}`;
    l2Parts.push(`⏱ ${bandStr} sorteos`);
  }
  if (c.avgPreMiss > 0) {
    const std = c.stdPreMiss > 0 ? `±${c.stdPreMiss}` : "";
    l2Parts.push(`🎯 activar tras ~${c.avgPreMiss}${std} fallos`);
  }
  if (l2Parts.length > 0) lines.push(`    ${l2Parts.join("  ")}`);

  // Línea 3: Comportamiento contextual (H/C + tendencia)
  const l3Parts: string[] = [];
  if (c.hitAfterHit >= 0 && c.hitAfterMiss >= 0) {
    const hh = (c.hitAfterHit * 100).toFixed(0);
    const hm = (c.hitAfterMiss * 100).toFixed(0);
    l3Parts.push(`🔥H→H:${hh}%  ❄️M→H:${hm}%`);
  }
  if (c.recentHitRate >= 0) {
    const pct = (c.recentHitRate * 100).toFixed(1);
    const sign = c.recentDelta >= 0 ? "+" : "";
    const arrow = c.trend === "up" ? "📈" : c.trend === "down" ? "📉" : "➡️";
    l3Parts.push(`${arrow}reciente ${pct}%(${sign}${c.recentDelta.toFixed(1)}pp)`);
  }
  if (l3Parts.length > 0) lines.push(`    ${l3Parts.join("  ")}`);

  return lines;
}

// ── Mensajes y teclados ───────────────────────────────────────────────────────

export function buildProgressiveContextKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📌 P3 Fijos · ☀️ Mediodía", "prog_ctx_p3_m").row()
    .text("📌 P3 Fijos · 🌙 Noche",     "prog_ctx_p3_e").row()
    .text("🎲 P4 Corridos · ☀️ Mediodía","prog_ctx_p4_m").row()
    .text("🎲 P4 Corridos · 🌙 Noche",  "prog_ctx_p4_e").row()
    .text("❌ Cancelar", "prog_cancel");
}

function detectActiveGroup(selectedIds: Set<string>, selectableIds: string[]): string | null {
  for (const group of CONSENSUS_GROUPS) {
    const gs = group.ids.filter((id) => selectableIds.includes(id));
    if (gs.length > 0 && gs.length === selectedIds.size && gs.every((id) => selectedIds.has(id)))
      return group.id;
  }
  return null;
}

export function buildProgressiveStrategyMessage(
  selectedIds: Set<string>,
  context: StrategyContext,
  selectableIds: string[],
  startDate: string,
  endDate: string
): string {
  const mapLabel = context.mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";
  const periodLabel = context.period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const activeGroup = detectActiveGroup(selectedIds, selectableIds);
  const nS = Math.min(selectedIds.size, PROGRESSIVE_MAX_STRATEGIES);
  const numCombos = nS >= 1 ? (1 << nS) - 1 : 0;

  let selectionStatus: string;
  if (selectedIds.size === 0) {
    selectionStatus = "_Sin estrategias seleccionadas (necesitas ≥ 2)_";
  } else if (selectedIds.size === 1) {
    selectionStatus = `_1 estrategia — necesitas al menos 2_`;
  } else if (activeGroup) {
    const group = CONSENSUS_GROUPS.find((g) => g.id === activeGroup);
    selectionStatus =
      `Grupo *${group?.label ?? activeGroup.toUpperCase()}* — ` +
      `${selectedIds.size} estrat. · *${numCombos}* combos`;
  } else {
    selectionStatus =
      `*${selectedIds.size}* estrategias · *${numCombos}* combinaciones a evaluar`;
  }

  return (
    `📈 *Análisis Progresivo* — ${mapLabel} · ${periodLabel}\n` +
    `📅 \`${startDate}\` → \`${endDate}\`\n\n` +
    `Selecciona estrategias. Detecta *patrones de certeza y fallo*:\n` +
    `_día/mes óptimo · ventana de juego · activar tras N fallos_\n` +
    `_comportamiento caliente/frío · tendencia reciente_\n\n` +
    selectionStatus
  );
}

export function buildProgressiveStrategyKeyboard(
  selectedIds: Set<string>,
  selectableIds: string[]
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const activeGroup = detectActiveGroup(selectedIds, selectableIds);

  for (let i = 0; i < CONSENSUS_GROUPS.length; i += 2) {
    const g1 = CONSENSUS_GROUPS[i]!;
    const g2 = CONSENSUS_GROUPS[i + 1];
    kb.text(
      `${g1.emoji} ${activeGroup === g1.id ? "✅ " : ""}Grupo ${g1.id.toUpperCase()}`,
      `prog_g_${g1.id}`
    );
    if (g2)
      kb.text(
        `${g2.emoji} ${activeGroup === g2.id ? "✅ " : ""}Grupo ${g2.id.toUpperCase()}`,
        `prog_g_${g2.id}`
      );
    kb.row();
  }

  kb.text("☑️ Seleccionar todas", "prog_all").text("🔲 Limpiar", "prog_none").row();

  for (const id of selectableIds) {
    const isSelected = selectedIds.has(id);
    const shortName = id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 16);
    kb.text(`${isSelected ? "✅" : "⬜"} ${shortName}`, `prog_st_${id}`).row();
  }

  if (selectedIds.size >= 2) {
    const nS = Math.min(selectedIds.size, PROGRESSIVE_MAX_STRATEGIES);
    kb.text(`▶️ Analizar (${(1 << nS) - 1} combos)`, "prog_run").row();
  }
  kb.text("❌ Cancelar", "prog_cancel");
  return kb;
}

export function buildProgressiveResultMessage(
  result: ProgressiveResult,
  strategyLabels: string[]
): string {
  const periodLabel = result.context.period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = result.context.mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  const cappedNote =
    result.totalInRange > result.datesAnalyzed
      ? ` _(${result.datesAnalyzed}/${result.totalInRange})_`
      : "";

  const lines: string[] = [
    `📊 *Análisis Progresivo* — ${mapLabel} · ${periodLabel}`,
    `📅 \`${result.startDate}\` → \`${result.endDate}\``,
    `🔢 *${result.datesAnalyzed}* fechas${cappedNote} · Top *${result.topN}* · *${result.totalSubsets}* combos`,
    ``,
    `*Leyenda de estrategias:*`,
  ];
  for (let i = 0; i < Math.min(strategyLabels.length, result.strategyCount); i++) {
    lines.push(`  ${String.fromCharCode(65 + i)} = ${strategyLabels[i]}`);
  }
  lines.push(
    ``,
    `_Condiciones: 📅día · 📆mes · ⏱ventana · 🎯activar tras N fallos_`,
    `_             🔥H→H hit-tras-hit · ❄️M→H hit-tras-fallo · 📈/📉tendencia_`,
  );

  // ── Top N combinaciones ────────────────────────────────────────────────────
  lines.push(``, `🏆 *Top ${Math.min(TOP_COMBOS_DISPLAY, result.topSubsets.length)} combinaciones:*`);

  for (let i = 0; i < result.topSubsets.length; i++) {
    const s = result.topSubsets[i]!;
    const tot = s.hits + s.misses;
    const pct = (s.hitRate * 100).toFixed(1);
    const rank = i === 0 ? "1er" : `#${i + 1}`;
    lines.push(`\`${s.label.padEnd(14)}\` ${rank.padStart(3)}  ${s.hits}/${tot}  ${pct.padStart(5)}%`);
    if (s.conditions) {
      for (const cl of formatConditions(s.conditions, s.hitRate)) lines.push(cl);
    }
  }

  // ── Mejor por tamaño ───────────────────────────────────────────────────────
  if (result.bestBySize.length > 1) {
    lines.push(``, `🥇 *Mejor por número de estrategias:*`);
    for (const s of result.bestBySize) {
      const tot = s.hits + s.misses;
      const pct = (s.hitRate * 100).toFixed(1);
      lines.push(`\`×${s.indices.length} ${s.label.padEnd(13)}\`  ${s.hits}/${tot}  ${pct.padStart(5)}%`);
      if (s.conditions) {
        for (const cl of formatConditions(s.conditions, s.hitRate)) lines.push(cl);
      }
    }
  }

  if (result.totalInRange > result.datesAnalyzed) {
    lines.push(``, `_⚠️ Análisis limitado a ${result.datesAnalyzed} fechas (cap ${PROGRESSIVE_MAX_DATES})._`);
  }

  const full = lines.join("\n");
  return full.length > 4000 ? full.slice(0, 3985) + "\n\n_… (recortado)_" : full;
}
