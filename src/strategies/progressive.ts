/**
 * Análisis Progresivo — Back-testing iterativo con todas las combinaciones posibles.
 *
 * Recorre un rango de fechas día a día:
 *   1. Para cada "fecha de corte" D, construye la base de conocimientos limitada a ≤ D.
 *   2. Extrae candidatos de cada estrategia seleccionada (una sola vez por fecha).
 *   3. Evalúa las 2^N − 1 combinaciones posibles (todas las formas de agrupar
 *      las estrategias elegidas) usando bitmask para eficiencia máxima.
 *   4. Verifica si el sorteo real siguiente (> D) está en el top-N de cada combo.
 *   5. Acumula aciertos y fallos.
 *
 * Resultado: ranking de las mejores combinaciones (top 10 global + mejor por tamaño).
 *
 * Complejidad:
 *   · getCandidates: O(N × dates)          — dominante
 *   · evaluación subsets: O(2^N × dates)   — muy rápido (Int32Array + reset parcial)
 *   · memoria: O(2^N) typed arrays         — ~128 KB para N=15
 */

import { InlineKeyboard } from "grammy";
import type { DateDrawsMap, StrategyContext, StrategyDefinition } from "./types.js";
import { twoDigitNumbers, mmddyyToDate } from "./utils.js";
import { CONSENSUS_GROUPS } from "./consensus-multi.js";

// ── Constantes ────────────────────────────────────────────────────────────────

/** Número de candidatos del top a verificar por defecto. */
export const PROGRESSIVE_TOP_N = 10;

/**
 * Cap de fechas de corte a iterar (~365/año × período → 2500 cubre ~6-7 años).
 * Si el rango lo supera se analizan las primeras 2500 y se notifica.
 */
export const PROGRESSIVE_MAX_DATES = 2500;

/**
 * Por encima de este número de fechas se muestra una pantalla de confirmación
 * con la estimación de tiempo antes de lanzar el análisis.
 */
export const PROGRESSIVE_WARN_THRESHOLD = 400;

/** Máximo de estrategias permitidas en el análisis progresivo. */
export const PROGRESSIVE_MAX_STRATEGIES = 15; // 2^15 - 1 = 32 767 combos

/** Cuántas combinaciones mostrar en el ranking del resultado. */
const TOP_COMBOS_DISPLAY = 10;

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface ProgressiveSubset {
  /** Índices (0-based) de las estrategias en este subconjunto. */
  indices: number[];
  /** Etiqueta: "A" | "A+C" | "A+B+C" … */
  label: string;
  hits: number;
  misses: number;
  /** Fechas sin resultado real disponible o sin candidatos. */
  skipped: number;
  /** hits / (hits + misses). 0 si no hay datos. */
  hitRate: number;
}

export interface ProgressiveResult {
  /** Top 10 subconjuntos ordenados por hitRate descendente. */
  topSubsets: ProgressiveSubset[];
  /** El mejor subconjunto para cada tamaño (×1, ×2, …, ×N). */
  bestBySize: ProgressiveSubset[];
  /** Total de combinaciones únicas evaluadas (= 2^N − 1). */
  totalSubsets: number;
  context: StrategyContext;
  startDate: string;
  endDate: string;
  /** Fechas de corte efectivamente iteradas. */
  datesAnalyzed: number;
  /** Total de fechas válidas en el rango antes del cap. */
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
  /** Número de fechas válidas en el rango (calculado antes de confirmar). */
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
  /**
   * Callback de progreso: recibe el porcentaje completado (0-100).
   * Se invoca cada 10% para actualizar la UI sin saturar la API de Telegram.
   */
  onProgress?: (pct: number) => Promise<void>;
}

// ── Utilidades internas ───────────────────────────────────────────────────────

/**
 * Precalcula para cada bitmask (1 → 2^n-1) sus índices activos y etiqueta.
 * Se llama UNA VEZ antes del loop principal → O(2^n) total.
 */
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

/**
 * Calcula cuántas fechas válidas hay en el rango [startDate, endDate].
 * Útil para estimar tiempo de procesamiento antes de confirmar la ejecución.
 */
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

// ── Motor ─────────────────────────────────────────────────────────────────────

/** Ejecuta el análisis progresivo evaluando TODAS las combinaciones posibles. */
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

  // ── 1. Parsear fechas UNA SOLA VEZ ─────────────────────────────────────────
  const keyTimeArr = Object.keys(fullMap).map((k) => ({
    k,
    t: mmddyyToDate(k)?.getTime() ?? 0,
  }));
  keyTimeArr.sort((a, b) => a.t - b.t);
  const allMapKeys = keyTimeArr.map((x) => x.k);
  const keyTime = new Map<string, number>(keyTimeArr.map((x) => [x.k, x.t]));

  // ── 2. Fechas válidas para el período/fuente ────────────────────────────────
  const allValidDates = allMapKeys.filter((d) => {
    const draw = fullMap[d]?.[context.period];
    return draw != null && draw.length >= minLen;
  });
  const validIdx = new Map<string, number>(allValidDates.map((d, i) => [d, i]));

  // ── 3. Fechas de corte en el rango ─────────────────────────────────────────
  const datesInRange = allValidDates.filter((d) => {
    const t = keyTime.get(d)!;
    return t >= startTime && t <= endTime;
  });
  const totalInRange = datesInRange.length;
  const cutoffDates = datesInRange.slice(0, PROGRESSIVE_MAX_DATES);

  // ── 4. Metadatos de los 2^n − 1 subconjuntos (precalculados una vez) ───────
  const totalSubsets = (1 << n) - 1;
  const subsetMeta = buildSubsetMeta(n);

  // ── 5. Contadores con typed arrays → caché-friendly, sin GC ────────────────
  const hitsArr = new Uint32Array(totalSubsets);
  const missesArr = new Uint32Array(totalSubsets);
  const skippedArr = new Uint32Array(totalSubsets);

  // ── 6. Buffers reutilizables para votos (evitan new Map() por subset) ───────
  //    voteCounts[num] = cuántas estrategias incluyen 'num' en sus candidatos
  //    usedNums: números para los que voteCounts > 0 (reset O(usedNums.len))
  const voteCounts = new Int32Array(100);
  const usedNums: number[] = [];

  // ── 7. Mapa filtrado INCREMENTAL ───────────────────────────────────────────
  const filteredMap: DateDrawsMap = {};
  let mapPtr = 0;
  while (mapPtr < allMapKeys.length && keyTime.get(allMapKeys[mapPtr]!)! < startTime) {
    filteredMap[allMapKeys[mapPtr]!] = fullMap[allMapKeys[mapPtr]!]!;
    mapPtr++;
  }

  // ── Loop principal ─────────────────────────────────────────────────────────
  const totalDates = cutoffDates.length;
  let processed = 0;
  let lastReportedPct = -1;

  for (const cutoffDate of cutoffDates) {
    const cutoffTime = keyTime.get(cutoffDate)!;

    // Avanza puntero incremental (O(1) amortizado)
    while (mapPtr < allMapKeys.length && keyTime.get(allMapKeys[mapPtr]!)! <= cutoffTime) {
      filteredMap[allMapKeys[mapPtr]!] = fullMap[allMapKeys[mapPtr]!]!;
      mapPtr++;
    }

    // Siguiente sorteo real (O(1) con índice precomputado)
    const nextDateStr = allValidDates[validIdx.get(cutoffDate)! + 1];
    if (!nextDateStr) {
      for (let i = 0; i < totalSubsets; i++) skippedArr[i]++;
      processed++;
      continue;
    }

    const nextDraw = fullMap[nextDateStr]?.[context.period];
    if (!nextDraw || nextDraw.length < minLen) {
      for (let i = 0; i < totalSubsets; i++) skippedArr[i]++;
      processed++;
      continue;
    }

    const actuals = twoDigitNumbers(nextDraw, context.mapSource);
    if (actuals.length === 0) {
      for (let i = 0; i < totalSubsets; i++) skippedArr[i]++;
      processed++;
      continue;
    }

    // Candidatos de todas las estrategias en paralelo (una vez por fecha de corte)
    const strategyCandidates = await Promise.all(
      effectiveIds.map(async (id) => {
        const strat = getStrategy(id);
        if (!strat?.getCandidates) return null;
        try {
          return await strat.getCandidates(context, filteredMap);
        } catch {
          return null;
        }
      })
    );

    // Set de actuals para lookup O(1) en el check de acierto
    const actualsSet = new Set(actuals);

    // ── Evalúa los 2^n − 1 subconjuntos ──────────────────────────────────────
    for (let maskIdx = 0; maskIdx < totalSubsets; maskIdx++) {
      const meta = subsetMeta[maskIdx]!;
      usedNums.length = 0;

      // Acumula votos de las estrategias del subset
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
      } else {
        // Ordena por votos descendente → top N es usedNums[0..topN-1]
        usedNums.sort((a, b) => voteCounts[b]! - voteCounts[a]!);

        let isHit = false;
        const limit = Math.min(topN, usedNums.length);
        for (let j = 0; j < limit && !isHit; j++) {
          if (actualsSet.has(usedNums[j]!)) isHit = true;
        }
        if (isHit) hitsArr[maskIdx]++; else missesArr[maskIdx]++;
      }

      // Reset parcial O(usedNums.length) — no repasa los 100 slots
      for (const num of usedNums) voteCounts[num] = 0;
    }

    processed++;
    if (onProgress && totalDates > 0) {
      const pct = Math.floor((processed / totalDates) * 100);
      if (pct >= lastReportedPct + 10) {
        lastReportedPct = pct;
        await onProgress(pct);
      }
    }
  }

  // ── Construye el resultado ─────────────────────────────────────────────────

  // Ordena todos los subsets por hitRate para obtener el ranking
  const rankOrder: number[] = [];
  for (let i = 0; i < totalSubsets; i++) {
    if (hitsArr[i]! + missesArr[i]! > 0) rankOrder.push(i);
  }
  rankOrder.sort((a, b) => {
    const totA = hitsArr[a]! + missesArr[a]!;
    const totB = hitsArr[b]! + missesArr[b]!;
    return hitsArr[b]! / totB - hitsArr[a]! / totA;
  });

  const makeSubset = (i: number): ProgressiveSubset => {
    const meta = subsetMeta[i]!;
    const tot = hitsArr[i]! + missesArr[i]!;
    return {
      indices: [...meta.indices],
      label: meta.label,
      hits: hitsArr[i]!,
      misses: missesArr[i]!,
      skipped: skippedArr[i]!,
      hitRate: tot > 0 ? hitsArr[i]! / tot : 0,
    };
  };

  const topSubsets = rankOrder.slice(0, TOP_COMBOS_DISPLAY).map(makeSubset);

  // Mejor subconjunto para cada tamaño (×1, ×2, …, ×n)
  const bestBySize: ProgressiveSubset[] = [];
  for (let size = 1; size <= n; size++) {
    const best = rankOrder.find((i) => subsetMeta[i]!.size === size);
    if (best !== undefined) bestBySize.push(makeSubset(best));
  }

  return {
    topSubsets,
    bestBySize,
    totalSubsets,
    context,
    startDate,
    endDate,
    datesAnalyzed: cutoffDates.length,
    totalInRange,
    topN,
    strategyCount: n,
  };
}

// ── Mensajes y teclados ───────────────────────────────────────────────────────

export function buildProgressiveContextKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📌 P3 Fijos · ☀️ Mediodía", "prog_ctx_p3_m")
    .row()
    .text("📌 P3 Fijos · 🌙 Noche", "prog_ctx_p3_e")
    .row()
    .text("🎲 P4 Corridos · ☀️ Mediodía", "prog_ctx_p4_m")
    .row()
    .text("🎲 P4 Corridos · 🌙 Noche", "prog_ctx_p4_e")
    .row()
    .text("❌ Cancelar", "prog_cancel");
}

function detectActiveGroup(
  selectedIds: Set<string>,
  selectableIds: string[]
): string | null {
  for (const group of CONSENSUS_GROUPS) {
    const groupSelectable = group.ids.filter((id) => selectableIds.includes(id));
    if (
      groupSelectable.length > 0 &&
      groupSelectable.length === selectedIds.size &&
      groupSelectable.every((id) => selectedIds.has(id))
    ) {
      return group.id;
    }
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
  const n = Math.min(selectedIds.size, PROGRESSIVE_MAX_STRATEGIES);
  const numCombos = n >= 1 ? (1 << n) - 1 : 0;

  let selectionStatus: string;
  if (selectedIds.size === 0) {
    selectionStatus = "_Sin estrategias seleccionadas (necesitas ≥ 2)_";
  } else if (selectedIds.size === 1) {
    selectionStatus = `_1 estrategia — necesitas al menos 2_`;
  } else if (activeGroup) {
    const group = CONSENSUS_GROUPS.find((g) => g.id === activeGroup);
    selectionStatus =
      `Grupo *${group?.label ?? activeGroup.toUpperCase()}* — ` +
      `${selectedIds.size} estrategias · *${numCombos}* combinaciones`;
  } else {
    selectionStatus =
      `*${selectedIds.size}* estrategia${selectedIds.size !== 1 ? "s" : ""} · ` +
      `*${numCombos}* combinacione${numCombos !== 1 ? "s" : ""} a evaluar`;
  }

  return (
    `📈 *Análisis Progresivo* — ${mapLabel} · ${periodLabel}\n` +
    `📅 \`${startDate}\` → \`${endDate}\`\n\n` +
    `Selecciona las estrategias. Se evaluarán *todas* las combinaciones posibles:\n` +
    `_C(N,1) + C(N,2) + … + C(N,N) = 2^N − 1 combos_\n\n` +
    selectionStatus
  );
}

export function buildProgressiveStrategyKeyboard(
  selectedIds: Set<string>,
  selectableIds: string[]
): InlineKeyboard {
  const kb = new InlineKeyboard();
  const activeGroup = detectActiveGroup(selectedIds, selectableIds);

  // Botones de grupo (2 por fila)
  for (let i = 0; i < CONSENSUS_GROUPS.length; i += 2) {
    const g1 = CONSENSUS_GROUPS[i]!;
    const g2 = CONSENSUS_GROUPS[i + 1];
    kb.text(
      `${g1.emoji} ${activeGroup === g1.id ? "✅ " : ""}Grupo ${g1.id.toUpperCase()}`,
      `prog_g_${g1.id}`
    );
    if (g2) {
      kb.text(
        `${g2.emoji} ${activeGroup === g2.id ? "✅ " : ""}Grupo ${g2.id.toUpperCase()}`,
        `prog_g_${g2.id}`
      );
    }
    kb.row();
  }

  kb.text("☑️ Seleccionar todas", "prog_all").text("🔲 Limpiar", "prog_none").row();

  for (const id of selectableIds) {
    const isSelected = selectedIds.has(id);
    const shortName = id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 16);
    kb.text(`${isSelected ? "✅" : "⬜"} ${shortName}`, `prog_st_${id}`).row();
  }

  if (selectedIds.size >= 2) {
    const n = Math.min(selectedIds.size, PROGRESSIVE_MAX_STRATEGIES);
    const numCombos = (1 << n) - 1;
    kb.text(`▶️ Analizar (${numCombos} combos)`, "prog_run").row();
  }
  kb.text("❌ Cancelar", "prog_cancel");

  return kb;
}

/** Construye el mensaje de resultados del análisis progresivo. */
export function buildProgressiveResultMessage(
  result: ProgressiveResult,
  strategyLabels: string[]
): string {
  const periodLabel = result.context.period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = result.context.mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  const cappedNote =
    result.totalInRange > result.datesAnalyzed
      ? ` _(${result.datesAnalyzed} de ${result.totalInRange} en el rango)_`
      : ``;

  const lines: string[] = [
    `📊 *Análisis Progresivo* — ${mapLabel} · ${periodLabel}`,
    `📅 \`${result.startDate}\` → \`${result.endDate}\``,
    `🔢 *${result.datesAnalyzed}* fechas${cappedNote} · Top *${result.topN}* · *${result.totalSubsets}* combos`,
    ``,
    `*Leyenda:*`,
  ];

  for (let i = 0; i < Math.min(strategyLabels.length, result.strategyCount); i++) {
    lines.push(`  ${String.fromCharCode(65 + i)} = ${strategyLabels[i]}`);
  }

  // ── Top 10 combinaciones ───────────────────────────────────────────────────
  lines.push(``, `🏆 *Top ${Math.min(TOP_COMBOS_DISPLAY, result.topSubsets.length)} combinaciones:*`);
  lines.push("```");
  lines.push(`Combo             Ac/Tot    %`);
  lines.push(`────────────────────────────`);

  for (let i = 0; i < result.topSubsets.length; i++) {
    const s = result.topSubsets[i]!;
    const tot = s.hits + s.misses;
    const pct = (s.hitRate * 100).toFixed(1);
    const rank = i === 0 ? " 1er" : ` #${i + 1}`;
    lines.push(`${s.label.padEnd(14)}${rank}  ${s.hits}/${tot}  ${pct.padStart(5)}%`);
  }
  lines.push("```");

  // ── Mejor por tamaño ───────────────────────────────────────────────────────
  if (result.bestBySize.length > 1) {
    lines.push(``, `🥇 *Mejor por número de estrategias:*`);
    lines.push("```");
    for (const s of result.bestBySize) {
      const tot = s.hits + s.misses;
      const pct = (s.hitRate * 100).toFixed(1);
      lines.push(
        `×${s.indices.length} ${s.label.padEnd(14)}  ${s.hits}/${tot}  ${pct.padStart(5)}%`
      );
    }
    lines.push("```");
  }

  if (result.totalInRange > result.datesAnalyzed) {
    lines.push(
      ``,
      `_⚠️ Primeras ${result.datesAnalyzed} fechas del rango (cap ${PROGRESSIVE_MAX_DATES})._`
    );
  }

  const full = lines.join("\n");
  return full.length > 4000 ? full.slice(0, 3985) + "\n\n_… (recortado)_" : full;
}
