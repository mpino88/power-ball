/**
 * BallBackTest — Motor de Auditoría Forense y Fusiones Dinámicas.
 * Réplica inicial de progressive.ts bajo Protocolo BLISS.
 */

import { InlineKeyboard } from "grammy";
import type { DateDrawsMap, StrategyContext, StrategyDefinition } from "./types.js";
import { twoDigitNumbers, mmddyyToDate } from "./utils.js";
import { CONSENSUS_GROUPS } from "./consensus-multi.js";

// ── Constantes ────────────────────────────────────────────────────────────────

export const BBT_TOP_N = 10;
export const BBT_MAX_DATES = 2500;
export const BBT_MAX_STRATEGIES = 15;
const TOP_COMBOS_DISPLAY = 10;
const RECENT_WINDOW = 50;

const DOW_LABELS = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"] as const;
const MONTH_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"] as const;

const INTERVAL_BUCKETS = 10;
const BUCKET_WIDTH = 5;
const BUCKET_LABELS = ["1-5", "6-10", "11-15", "16-20", "21-25", "26-30", "31-35", "36-40", "41-45", "46+"] as const;
const BUCKET_MIDPOINTS = [3, 8, 13, 18, 23, 28, 33, 38, 43, 48];

function intervalBucket(interval: number): number {
  const b = Math.floor((interval - 1) / BUCKET_WIDTH);
  return Math.min(b, INTERVAL_BUCKETS - 1);
}

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface BBTConditions {
  bestDows: Array<{ label: string; hitRate: number }>;
  bestMonths: Array<{ label: string; hitRate: number }>;
  avgInterval: number;
  stdInterval: number;
  peakBand: string;
  p25: number;
  p75: number;
  avgPreMiss: number;
  stdPreMiss: number;
  hitAfterHit: number;
  hitAfterMiss: number;
  recentHitRate: number;
  recentDelta: number;
  trend: "up" | "down" | "stable";
}

export interface BBTSubset {
  indices: number[];
  label: string;
  hits: number;
  misses: number;
  skipped: number;
  hitRate: number;
  conditions?: BBTConditions;
}

export interface BBTForensicEntry {
  x: string;         // Fecha
  type: string;      // Contextos (ej: "P3M+P4N")
  y_hit: boolean;    // Acierto en cualquiera
  z_miss: boolean;   // Fallo en todos
  d_convergence: number; // Grado de convergencia (0-1)
  winning: number[]; // Todos los números ganadores combinados
  candidates: number[]; // Top candidatos generados
}

export interface BBTResult {
  topSubsets: BBTSubset[];
  bestBySize: BBTSubset[];
  forensicLog: BBTForensicEntry[];
  totalSubsets: number;
  contexts: StrategyContext[];
  startDate: string;
  endDate: string;
  datesAnalyzed: number;
  totalInRange: number;
  topN: number;
  strategyCount: number;
}

export interface BBTParams {
  startDate: string;
  endDate: string;
  strategyIds: string[];
  contexts: StrategyContext[];
  topN: number;
  fullMap: DateDrawsMap;
  getStrategy: (id: string) => StrategyDefinition | undefined;
  onProgress?: (pct: number) => Promise<void>;
}

export interface BallBackTestSession {
  step: "context" | "start_date" | "end_date" | "strategies" | "top_n" | "confirm";
  selectedContexts: Set<string>; // "p3_m", "p4_e", etc.
  startDate?: string;
  endDate?: string;
  selectedIds: Set<string>;
  estimatedDates?: number;
  topN?: number; // 0 para "todos"
}

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

export async function runBallBackTest(params: BBTParams): Promise<BBTResult> {
  const { startDate, endDate, strategyIds, contexts, topN, fullMap, getStrategy, onProgress } = params;

  const n = Math.min(strategyIds.length, BBT_MAX_STRATEGIES);
  const effectiveIds = strategyIds.slice(0, n);

  const startDt = mmddyyToDate(startDate);
  const endDt = mmddyyToDate(endDate);
  if (!startDt || !endDt || startDt > endDt) throw new Error("Rango de fechas inválido");

  const startTime = startDt.getTime();
  const endTime = endDt.getTime();
  const keyTimeArr = Object.keys(fullMap).map((k) => ({ k, t: mmddyyToDate(k)?.getTime() ?? 0 }));
  keyTimeArr.sort((a, b) => a.t - b.t);
  const allMapKeys = keyTimeArr.map((x) => x.k);
  const keyTime = new Map<string, number>(keyTimeArr.map((x) => [x.k, x.t]));

  // Un día es válido si tiene al menos un sorteo en cualquiera de los contextos seleccionados
  const validateDraw = (date: string, ctx: StrategyContext) => {
    const draw = fullMap[date]?.[ctx.period];
    const minLen = ctx.mapSource === "p4" ? 4 : 3;
    return draw != null && draw.length >= minLen;
  };

  const allValidDates = allMapKeys.filter((d: string) => 
    contexts.some(c => validateDraw(d, c))
  );
  const validIdx = new Map<string, number>(allValidDates.map((d: string, i: number) => [d, i]));

  const datesInRange = allValidDates.filter((d) => {
    const t = keyTime.get(d)!;
    return t >= startTime && t <= endTime;
  });
  const totalInRange = datesInRange.length;
  const cutoffDates = datesInRange.slice(0, BBT_MAX_DATES);
  const totalDates = cutoffDates.length;

  const totalSubsets = (1 << n) - 1;
  const subsetMeta = buildSubsetMeta(n);

  const hitsArr = new Uint32Array(totalSubsets);
  const missesArr = new Uint32Array(totalSubsets);
  const skippedArr = new Uint32Array(totalSubsets);
  const forensicLog: BBTForensicEntry[] = [];
  const hitsByDow = new Uint16Array(totalSubsets * 7);
  const totByDow = new Uint16Array(totalSubsets * 7);
  const hitsByMonth = new Uint16Array(totalSubsets * 12);
  const totByMonth = new Uint16Array(totalSubsets * 12);
  const lastHitIdx = new Int32Array(totalSubsets).fill(-1);
  const intervalCnt = new Uint16Array(totalSubsets);
  const intervalMean = new Float64Array(totalSubsets);
  const intervalM2 = new Float64Array(totalSubsets);
  const intervalBucketsArr = new Uint16Array(totalSubsets * INTERVAL_BUCKETS);
  const currentMissStreak = new Uint16Array(totalSubsets);
  const preMissCnt = new Uint16Array(totalSubsets);
  const preMissMean = new Float64Array(totalSubsets);
  const preMissM2 = new Float64Array(totalSubsets);
  const prevState = new Uint8Array(totalSubsets);
  const hitsAfterHit = new Uint16Array(totalSubsets);
  const totAfterHit = new Uint16Array(totalSubsets);
  const hitsAfterMiss = new Uint16Array(totalSubsets);
  const totAfterMiss = new Uint16Array(totalSubsets);
  const recentHits = new Uint16Array(totalSubsets);
  const recentTotal = new Uint16Array(totalSubsets);
  const recentStart = Math.max(0, totalDates - RECENT_WINDOW);

  const filteredMap: DateDrawsMap = {};
  let mapPtr = 0;
  while (mapPtr < allMapKeys.length && keyTime.get(allMapKeys[mapPtr]!)! < startTime) {
    filteredMap[allMapKeys[mapPtr]!] = fullMap[allMapKeys[mapPtr]!]!;
    mapPtr++;
  }

  const voteCounts = new Int32Array(100);
  const usedNums: number[] = [];
  let lastReportedPct = -1;

  for (let dateIdx = 0; dateIdx < totalDates; dateIdx++) {
    const cutoffDate = cutoffDates[dateIdx]!;
    const cutoffTime = keyTime.get(cutoffDate)!;
    const isRecent = dateIdx >= recentStart;

    while (mapPtr < allMapKeys.length && keyTime.get(allMapKeys[mapPtr]!)! <= cutoffTime) {
      filteredMap[allMapKeys[mapPtr]!] = fullMap[allMapKeys[mapPtr]!]!;
      mapPtr++;
    }

    const nextDateStr = allValidDates[validIdx.get(cutoffDate)! + 1];
    if (!nextDateStr) {
      for (let i = 0; i < totalSubsets; i++) skippedArr[i]++;
      continue;
    }

    // Obtener ganadores combinados de todos los contextos activos para este sorteo
    const actualsSet = new Set<number>();
    const activeContextNames: string[] = [];

    for (const ctx of contexts) {
      const draw = fullMap[nextDateStr]?.[ctx.period];
      const minLen = ctx.mapSource === "p4" ? 4 : 3;
      if (draw && draw.length >= minLen) {
        twoDigitNumbers(draw, ctx.mapSource).forEach(n => actualsSet.add(n));
        activeContextNames.push(`${ctx.mapSource.toUpperCase()}${ctx.period.toUpperCase()}`);
      }
    }

    if (actualsSet.size === 0) {
      for (let i = 0; i < totalSubsets; i++) skippedArr[i]++;
      continue;
    }

    const actuals = Array.from(actualsSet);
    const nextDt = mmddyyToDate(nextDateStr);
    const nextDow = nextDt ? nextDt.getDay() : -1;
    const nextMonth = nextDt ? nextDt.getMonth() : -1;

    // Acumular candidatos de todas las estrategias en TODOS los contextos
    // Formato: contextIdx -> strategyIdx -> candidates
    const multiContextCandidates = await Promise.all(
      contexts.map(async (ctx) => {
        return Promise.all(
          effectiveIds.map(async (id) => {
            const strat = getStrategy(id);
            if (!strat?.getCandidates) return null;
            try { return await strat.getCandidates(ctx, filteredMap); } catch { return null; }
          })
        );
      })
    );

    // Identificar qué contextos tienen sorteo real para este "nextDate"
    const activeContexts = contexts.filter(ctx => {
      const d = fullMap[nextDateStr]?.[ctx.period];
      return d && d.length >= (ctx.mapSource === "p4" ? 4 : 3);
    });

    if (activeContexts.length === 0) {
      for (let i = 0; i < totalSubsets; i++) skippedArr[i]++;
      continue;
    }

    const allWinningNums = new Set<number>();
    activeContexts.forEach(ctx => {
      const d = fullMap[nextDateStr]![ctx.period]!;
      twoDigitNumbers(d, ctx.mapSource).forEach(n => allWinningNums.add(n));
    });

    const forensicEntry: BBTForensicEntry = {
      x: nextDateStr,
      type: activeContexts.map(c => `${c.mapSource.toUpperCase()}${c.period.toUpperCase()}`).join("+"),
      y_hit: false,
      z_miss: true,
      d_convergence: 0,
      winning: [...allWinningNums],
      candidates: []
    };

    for (let maskIdx = 0; maskIdx < totalSubsets; maskIdx++) {
      const meta = subsetMeta[maskIdx]!;
      usedNums.length = 0;

      // Reset vote counts
      // (voteCounts ya fue inicializado a 0 en el constructor del motor anterior)

      // Votación Multi-Contexto: Sumamos votos de cada estrategia en cada contexto seleccionado
      for (const stratIdx of meta.indices) {
        for (let ctxIdx = 0; ctxIdx < contexts.length; ctxIdx++) {
          const cands = multiContextCandidates[ctxIdx]![stratIdx];
          if (!cands) continue;
          for (const num of cands) {
            if (voteCounts[num] === 0) usedNums.push(num);
            voteCounts[num]++;
          }
        }
      }

      if (usedNums.length === 0) {
        skippedArr[maskIdx]++;
        continue;
      }

      usedNums.sort((a, b) => voteCounts[b]! - voteCounts[a]!);
      let isHit = false;
      const limit = (topN === 0) ? usedNums.length : Math.min(topN, usedNums.length);

      // Para el log forense, usamos el set COMPLETO de estrategias (último subset)
      if (maskIdx === totalSubsets - 1) {
        forensicEntry.candidates = usedNums.slice(0, Math.min(20, usedNums.length));
        let totalVotes = 0;
        for (let j = 0; j < limit; j++) totalVotes += voteCounts[usedNums[j]!]!;
        // Normalización: votos / (registros * contextos * estrategias_en_subset)
        forensicEntry.d_convergence = totalVotes / (limit * contexts.length * meta.indices.length || 1);
      }

      for (let j = 0; j < limit && !isHit; j++) {
        if (allWinningNums.has(usedNums[j]!)) isHit = true;
      }

      if (maskIdx === totalSubsets - 1) {
        forensicEntry.y_hit = isHit;
        forensicEntry.z_miss = !isHit;
        forensicLog.push(forensicEntry);
      }

      // Cleanup voteCounts for next mask
      for (const num of usedNums) voteCounts[num] = 0;

      if (isHit) {
        hitsArr[maskIdx]++;
        if (nextDow >= 0) { hitsByDow[maskIdx * 7 + nextDow]++; totByDow[maskIdx * 7 + nextDow]++; }
        if (nextMonth >= 0) { hitsByMonth[maskIdx * 12 + nextMonth]++; totByMonth[maskIdx * 12 + nextMonth]++; }
        if (lastHitIdx[maskIdx] >= 0) {
          const interval = dateIdx - lastHitIdx[maskIdx];
          const cnt = ++intervalCnt[maskIdx];
          const delta = interval - intervalMean[maskIdx];
          intervalMean[maskIdx] += delta / cnt;
          intervalM2[maskIdx] += delta * (interval - intervalMean[maskIdx]);
          intervalBucketsArr[maskIdx * INTERVAL_BUCKETS + intervalBucket(interval)]++;
        }
        lastHitIdx[maskIdx] = dateIdx;
        const pmCntVal = ++preMissCnt[maskIdx];
        const pmDelta = currentMissStreak[maskIdx] - preMissMean[maskIdx];
        preMissMean[maskIdx] += pmDelta / pmCntVal;
        preMissM2[maskIdx] += pmDelta * (currentMissStreak[maskIdx] - preMissMean[maskIdx]);
        currentMissStreak[maskIdx] = 0;
        const ps = prevState[maskIdx];
        if (ps === 1) { hitsAfterHit[maskIdx]++; totAfterHit[maskIdx]++; } else if (ps === 2) { hitsAfterMiss[maskIdx]++; totAfterMiss[maskIdx]++; }
        prevState[maskIdx] = 1;
        if (isRecent) { recentHits[maskIdx]++; recentTotal[maskIdx]++; }
      } else {
        missesArr[maskIdx]++;
        currentMissStreak[maskIdx]++;
        if (nextDow >= 0) totByDow[maskIdx * 7 + nextDow]++;
        if (nextMonth >= 0) totByMonth[maskIdx * 12 + nextMonth]++;
        const ps = prevState[maskIdx];
        if (ps === 1) totAfterHit[maskIdx]++; else if (ps === 2) totAfterMiss[maskIdx]++;
        prevState[maskIdx] = 2;
        if (isRecent) recentTotal[maskIdx]++;
      }
    }
    if (onProgress && totalDates > 0) {
      const pct = Math.floor(((dateIdx + 1) / totalDates) * 100);
      if (pct >= lastReportedPct + 10) { lastReportedPct = pct; await onProgress(pct); }
    }
  }

  const buildConditions = (i: number, overallHitRate: number): BBTConditions => {
    const dowRates: any[] = [];
    for (let d = 0; d < 7; d++) {
      const tot = totByDow[i * 7 + d];
      if (tot >= 3) dowRates.push({ label: DOW_LABELS[d], hitRate: hitsByDow[i * 7 + d]! / tot });
    }
    dowRates.sort((a, b) => b.hitRate - a.hitRate);
    const monthRates: any[] = [];
    for (let m = 0; m < 12; m++) {
      const tot = totByMonth[i * 12 + m];
      if (tot >= 2) monthRates.push({ label: MONTH_LABELS[m], hitRate: hitsByMonth[i * 12 + m]! / tot });
    }
    monthRates.sort((a, b) => b.hitRate - a.hitRate);
    const iCnt = intervalCnt[i]!;
    const avgI = iCnt > 0 ? Math.round(intervalMean[i]!) : 0;
    const stdI = iCnt >= 2 ? Math.round(Math.sqrt(intervalM2[i]! / iCnt)) : 0;
    let peakB = "", peakC = 0, totalI = 0;
    for (let b = 0; b < INTERVAL_BUCKETS; b++) {
      const c = intervalBucketsArr[i * INTERVAL_BUCKETS + b]!;
      totalI += c; if (c > peakC) { peakC = c; peakB = BUCKET_LABELS[b]!; }
    }
    let p25 = 0, p75 = 0;
    if (totalI > 0) {
      let cumul = 0, p25S = false;
      for (let b = 0; b < INTERVAL_BUCKETS; b++) {
        cumul += intervalBucketsArr[i * INTERVAL_BUCKETS + b]!;
        if (!p25S && cumul >= totalI * 0.25) { p25 = BUCKET_MIDPOINTS[b]!; p25S = true; }
        if (cumul >= totalI * 0.75) { p75 = BUCKET_MIDPOINTS[b]!; break; }
      }
    }
    const pmCntVal = preMissCnt[i]!;
    const avgPM = pmCntVal > 0 ? Math.round(preMissMean[i]!) : 0;
    const stdPM = pmCntVal >= 2 ? Math.round(Math.sqrt(preMissM2[i]! / pmCntVal)) : 0;
    const tAH = totAfterHit[i]!, tAM = totAfterMiss[i]!;
    const hAH = tAH > 0 ? hitsAfterHit[i]! / tAH : -1;
    const hAM = tAM > 0 ? hitsAfterMiss[i]! / tAM : -1;
    const rTot = recentTotal[i]!;
    const rHR = rTot >= 10 ? recentHits[i]! / rTot : -1;
    const rDelta = rHR >= 0 ? (rHR - overallHitRate) * 100 : 0;
    const tr: any = rHR < 0 ? "stable" : rDelta >= 3 ? "up" : rDelta <= -3 ? "down" : "stable";

    return {
      bestDows: dowRates.slice(0, 2), bestMonths: monthRates.slice(0, 2),
      avgInterval: avgI, stdInterval: stdI, peakBand: peakB, p25, p75,
      avgPreMiss: avgPM, stdPreMiss: stdPM, hitAfterHit: hAH, hitAfterMiss: hAM,
      recentHitRate: rHR, recentDelta: rDelta, trend: tr
    };
  };

  const rankOrder: number[] = [];
  for (let i = 0; i < totalSubsets; i++) { if (hitsArr[i]! + missesArr[i]! > 0) rankOrder.push(i); }
  rankOrder.sort((a, b) => {
    const totA = hitsArr[a]! + missesArr[a]!, totB = hitsArr[b]! + missesArr[b]!;
    return hitsArr[b]! / totB - hitsArr[a]! / totA;
  });

  const topSubsets = rankOrder.slice(0, TOP_COMBOS_DISPLAY).map(i => {
    const tot = hitsArr[i]! + missesArr[i]!, hr = tot > 0 ? hitsArr[i]! / tot : 0;
    return { indices: [...subsetMeta[i]!.indices], label: subsetMeta[i]!.label, hits: hitsArr[i]!, misses: missesArr[i]!, skipped: skippedArr[i]!, hitRate: hr, conditions: buildConditions(i, hr) };
  });

  const bestBySize: BBTSubset[] = [];
  for (let size = 1; size <= n; size++) {
    const best = rankOrder.find(i => subsetMeta[i]!.size === size);
    if (best !== undefined) {
      const tot = hitsArr[best]! + missesArr[best]!, hr = tot > 0 ? hitsArr[best]! / tot : 0;
      bestBySize.push({ indices: [...subsetMeta[best]!.indices], label: subsetMeta[best]!.label, hits: hitsArr[best]!, misses: missesArr[best]!, skipped: skippedArr[best]!, hitRate: hr, conditions: buildConditions(best, hr) });
    }
  }

  return { topSubsets, bestBySize, forensicLog, totalSubsets, contexts, startDate, endDate, datesAnalyzed: cutoffDates.length, totalInRange, topN, strategyCount: n };
}

// ── Mensajes y teclados ───────────────────────────────────────────────────────

export function buildBBTContextKeyboard(selected?: Set<string>): InlineKeyboard {
  const kb = new InlineKeyboard();
  const options = [
    { id: "p3_m", label: "📌 P3 Fijos · ☀️ Mediodía" },
    { id: "p3_e", label: "📌 P3 Fijos · 🌙 Noche" },
    { id: "p4_m", label: "🎲 P4 Corridos · ☀️ Mediodía" },
    { id: "p4_e", label: "🎲 P4 Corridos · 🌙 Noche" },
  ];

  for (const opt of options) {
    const isSelected = selected?.has(opt.id);
    kb.text(`${isSelected ? "✅" : "⬜"} ${opt.label}`, `bbt_ctx_${opt.id}`).row();
  }

  // Botones de acción rápida
  kb.text("⚡ P3 Ambos", "bbt_ctx_p3_both")
    .text("⚡ P4 Ambos", "bbt_ctx_p4_both").row()
    .text("🌟 Seleccionar TODO", "bbt_ctx_all").row();

  if (selected && selected.size > 0) {
    kb.text(`▶️ Continuar (${selected.size} seleccionados)`, "bbt_ctx_done").row();
  }
  kb.text("❌ Cancelar", "bbt_cancel");
  return kb;
}

export function buildBBTStrategyKeyboard(selectedIds: Set<string>, selectableIds: string[]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const id of selectableIds) {
    const isSelected = selectedIds.has(id);
    const shortName = id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 16);
    kb.text(`${isSelected ? "✅" : "⬜"} ${shortName}`, `bbt_st_${id}`).row();
  }
  if (selectedIds.size >= 1) {
    const nS = Math.min(selectedIds.size, BBT_MAX_STRATEGIES);
    const numCombos = (1 << nS) - 1;
    kb.text(`▶️ Iniciar BallBackTest (${numCombos} combos)`, "bbt_run").row();
  }
  kb.text("❌ Cancelar", "bbt_cancel");
  return kb;
}

export function buildBBTStrategyMessage(
  selectedIds: Set<string>,
  contexts: StrategyContext[],
  selectableIds: string[],
  startDate: string,
  endDate: string
): string {
  const ctxLabels = contexts.map(c => `${c.mapSource.toUpperCase()}${c.period.toUpperCase()}`).join(", ");
  const n = Math.min(selectedIds.size, BBT_MAX_STRATEGIES);
  const numCombos = (1 << n) - 1;

  let msg = `🚀 *BallBackTest — Configuración*\n\n`;
  msg += `📊 *Contextos:* ${ctxLabels}\n`;
  msg += `📅 *Rango:* \`${startDate}\` → \`${endDate}\`\n\n`;
  msg += `✅ *Seleccionadas:* ${selectedIds.size} estrategias\n`;
  msg += `🔢 *Combinaciones:* ${numCombos}\n\n`;
  msg += `_Selecciona las estrategias que deseas fusionar para la auditoría:_`;
  return msg;
}

export function buildBBTResultMessage(result: BBTResult, strategyLabels: string[]): string {
  const { topSubsets, bestBySize, contexts, startDate, endDate, datesAnalyzed, totalInRange, topN } = result;
  const ctxHeader = contexts.map(c => `${c.mapSource.toUpperCase()}${c.period.toUpperCase()}`).join("+");

  let msg = `🏆 *RESULTADOS BALLBACKTEST*\n`;
  msg += `📊 [${ctxHeader}] | \`${startDate}\` → \`${endDate}\`\n`;
  msg += `🔢 Analizadas: *${datesAnalyzed}* / ${totalInRange} fechas\n`;
  msg += `🎯 Top N candidatos: *${topN === 0 ? "TODOS" : topN}*\n\n`;

  msg += `📋 *Leyenda Estrategias:*\n`;
  strategyLabels.forEach((label, i) => {
    msg += `*${String.fromCharCode(65 + i)}:* ${label}\n`;
  });
  msg += `\n`;

  msg += `🔥 *TOP COMBINACIONES (Hit Rate):*\n`;
  topSubsets.slice(0, 5).forEach((s, i) => {
    const hrP = (s.hitRate * 100).toFixed(1);
    msg += `${i + 1}. [${s.label}] → *${hrP}%* (${s.hits}✅ / ${s.misses}❌)\n`;
    if (s.conditions) {
      msg += `   └ _Tendencia:_ ${s.conditions.trend === "up" ? "📈" : s.conditions.trend === "down" ? "📉" : "➡️"} | _Intervalo:_ ~${s.conditions.avgInterval}d\n`;
    }
  });

  msg += `\n🏗 *MEJOR POR TAMAÑO (Eficiencia):*\n`;
  bestBySize.forEach((s) => {
    const hrP = (s.hitRate * 100).toFixed(1);
    msg += `• *${s.indices.length}* strat [${s.label}] → *${hrP}%*\n`;
  });

  msg += `\n_Resultados basados en auditoría forense Bliss Systems._`;
  return msg;
}

// ── BBT Compare Mode ──────────────────────────────────────────────────────────

/** Períodos disponibles en el modo comparativo, incluye P3 Ambos. */
export const BBT_CMP_PERIODS = [
  { id: "p3_m", label: "P3 ☀️ Mediodía" },
  { id: "p3_e", label: "P3 🌙 Noche" },
  { id: "p3_a", label: "P3 🌗 Ambos" },
  { id: "p4_m", label: "P4 ☀️ Mediodía" },
  { id: "p4_e", label: "P4 🌙 Noche" },
] as const;

export type BBTCmpPeriodId = (typeof BBT_CMP_PERIODS)[number]["id"];

export interface BBTCompareSession {
  step: "strategies" | "period" | "limit" | "running";
  selectedIds: Set<string>;
  selectedPeriods: Set<BBTCmpPeriodId>;
  limit: number;
  waitingCustomLimit: boolean;
}

export interface BBTCompareEntry {
  stratId: string;
  period: BBTCmpPeriodId;
  candidates: number[];
}

export interface BBTCompareResult {
  entries: BBTCompareEntry[];
  limit: number;
  selectedIds: string[];
  selectedPeriods: BBTCmpPeriodId[];
}

// ── Teclados Compare ─────────────────────────────────────────────────────────

export function buildBBTCompareStrategyKeyboard(
  selectedIds: Set<string>,
  selectableIds: string[]
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const id of selectableIds) {
    const isSelected = selectedIds.has(id);
    const label = id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 22);
    kb.text(`${isSelected ? "✅" : "⬜"} ${label}`, `bbt_cmp_st_${id}`).row();
  }
  if (selectedIds.size >= 2) {
    kb.text(`▶️ Continuar (${selectedIds.size} estrategias)`, "bbt_cmp_st_done").row();
  } else {
    kb.text("⚠️ Selecciona mínimo 2 para comparar", "bbt_cmp_st_hint").row();
  }
  kb.text("❌ Cancelar", "bbt_cmp_cancel");
  return kb;
}

export function buildBBTComparePeriodKeyboard(selected: Set<string>): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const opt of BBT_CMP_PERIODS) {
    const isSelected = selected.has(opt.id);
    kb.text(`${isSelected ? "✅" : "⬜"} ${opt.label}`, `bbt_cmp_ctx_${opt.id}`).row();
  }
  if (selected.size >= 1) {
    kb.text(`▶️ Continuar (${selected.size} período(s))`, "bbt_cmp_ctx_done").row();
  }
  kb.text("❌ Cancelar", "bbt_cmp_cancel");
  return kb;
}

export function buildBBTCompareLimitKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("5",  "bbt_cmp_lim_5")
    .text("10", "bbt_cmp_lim_10")
    .text("20", "bbt_cmp_lim_20")
    .text("30", "bbt_cmp_lim_30")
    .row()
    .text("✏️ Personalizado", "bbt_cmp_lim_custom")
    .row()
    .text("❌ Cancelar", "bbt_cmp_cancel");
}

// ── Motor de comparación ─────────────────────────────────────────────────────

export async function runBBTCompare(
  selectedIds: string[],
  selectedPeriods: BBTCmpPeriodId[],
  limit: number,
  getMap: (source: "p3" | "p4") => Promise<DateDrawsMap>,
  getStrategyFn: (id: string) => StrategyDefinition | undefined
): Promise<BBTCompareResult> {
  const mapCache = new Map<string, DateDrawsMap>();
  const cachedMap = async (source: "p3" | "p4"): Promise<DateDrawsMap> => {
    if (!mapCache.has(source)) mapCache.set(source, await getMap(source));
    return mapCache.get(source)!;
  };

  const entries: BBTCompareEntry[] = [];

  for (const period of selectedPeriods) {
    const [source, rawPeriod] = period.split("_") as ["p3" | "p4", string];
    const ambos = rawPeriod === "a";
    const finalPeriod: "m" | "e" = ambos ? "m" : (rawPeriod as "m" | "e");
    const map = await cachedMap(source);

    for (const stratId of selectedIds) {
      const strat = getStrategyFn(stratId);
      if (!strat?.getCandidates) continue;

      const ctx: StrategyContext = {
        mapSource: source,
        period: finalPeriod,
        params: ambos ? { ambos: true, limit } : { limit },
      };

      const candidates = (await strat.getCandidates(ctx, map)).slice(0, limit);
      entries.push({ stratId, period, candidates });
    }
  }

  return { entries, limit, selectedIds, selectedPeriods };
}

// ── Formateador del resultado ─────────────────────────────────────────────────

export function buildBBTCompareResultMessage(
  result: BBTCompareResult,
  getLabel: (id: string) => string
): string {
  const { entries, limit, selectedIds, selectedPeriods } = result;

  const pad = (n: number) => String(n).padStart(2, "0");
  const PERIOD_LABEL: Record<string, string> = {
    p3_m: "P3 ☀️ Mediodía",
    p3_e: "P3 🌙 Noche",
    p3_a: "P3 🌗 Ambos",
    p4_m: "P4 ☀️ Mediodía",
    p4_e: "P4 🌙 Noche",
  };

  const stratLabels = selectedIds.map(getLabel);
  const lines: string[] = [
    `🔬 *Análisis Comparativo — Top ${limit}*`,
    `Estrategias: ${stratLabels.join(", ")}`,
    "",
  ];

  for (const period of selectedPeriods) {
    const periodEntries = entries.filter((e) => e.period === period);
    if (periodEntries.length === 0) continue;

    lines.push(`━━━ *${PERIOD_LABEL[period] ?? period}* ━━━`);

    // Candidatos por estrategia
    for (const entry of periodEntries) {
      const label = getLabel(entry.stratId).slice(0, 16).padEnd(16);
      lines.push(`*${label}:* \`${entry.candidates.map(pad).join(" ")}\``);
    }

    // Consenso (intersección de todas las estrategias en este período)
    if (periodEntries.length >= 2) {
      let shared = new Set(periodEntries[0]!.candidates);
      for (const e of periodEntries.slice(1)) {
        shared = new Set(e.candidates.filter((x) => shared.has(x)));
      }
      const sharedArr = [...shared];
      lines.push(
        `✅ *Consenso (${sharedArr.length}/${limit}):* ` +
        (sharedArr.length ? `\`${sharedArr.map(pad).join(" ")}\`` : "—")
      );

      // Exclusivos por estrategia
      for (const entry of periodEntries) {
        const others = new Set(
          periodEntries.filter((e) => e.stratId !== entry.stratId).flatMap((e) => e.candidates)
        );
        const only = entry.candidates.filter((x) => !others.has(x));
        if (only.length > 0) {
          const lbl = getLabel(entry.stratId).slice(0, 10);
          lines.push(`   _Solo ${lbl}:_ \`${only.map(pad).join(" ")}\``);
        }
      }
    }

    lines.push("");
  }

  lines.push(`_Motor: Fibonacci Resonance — datos reales Florida Lottery_`);

  // Telegram limit safe
  const full = lines.join("\n").trimEnd();
  return full.length > 4000 ? full.slice(0, 3990) + "\n\n_… (recortado)_" : full;
}
