/**
 * Análisis Progresivo — Back-testing iterativo de estrategias.
 *
 * Recorre un rango de fechas día a día:
 *   1. Para cada "fecha de corte" D, construye la base de conocimientos limitada a ≤ D.
 *   2. Extrae candidatos de cada estrategia seleccionada.
 *   3. Aplica consenso por votación para subconjuntos cumulativos:
 *        {A} → {A,B} → {A,B,C} → …
 *   4. Verifica si el sorteo real siguiente (> D) está en los top-N candidatos.
 *   5. Acumula aciertos y fallos por subconjunto.
 *
 * Resultado: tabla de tasas de acierto por combinación, lo que indica qué grupo
 * de estrategias tiene mayor poder predictivo en el período analizado.
 */

import { InlineKeyboard } from "grammy";
import type { DateDrawsMap, StrategyContext, StrategyDefinition } from "./types.js";
import { twoDigitNumbers, mmddyyToDate } from "./utils.js";
import { CONSENSUS_GROUPS } from "./consensus-multi.js";

// ── Constantes ────────────────────────────────────────────────────────────────

/** Número de candidatos del top a verificar por defecto. */
export const PROGRESSIVE_TOP_N = 10;

/**
 * Cap de seguridad: máximo de fechas de corte a iterar.
 * ~365 sorteos/año × periodo (M ó E) → 2500 cubre ~6-7 años de datos diarios.
 * Si el rango supera este límite, se analiza solo el primer tramo y se notifica.
 */
export const PROGRESSIVE_MAX_DATES = 2500;

/**
 * Umbral a partir del cual se muestra una advertencia de tiempo estimado antes de
 * confirmar la ejecución. Por debajo de este umbral se lanza directamente.
 */
export const PROGRESSIVE_WARN_THRESHOLD = 400;

// ── Tipos ─────────────────────────────────────────────────────────────────────

export interface ProgressiveSubset {
  strategyIds: string[];
  /** "A" | "A+B" | "A+B+C" | … */
  label: string;
  hits: number;
  misses: number;
  /** Fechas sin resultado real disponible o sin candidatos. */
  skipped: number;
  /** hits / (hits + misses). 0 si total = 0. */
  hitRate: number;
}

export interface ProgressiveResult {
  subsets: ProgressiveSubset[];
  context: StrategyContext;
  startDate: string;
  endDate: string;
  /** Fechas de corte efectivamente iteradas (≤ PROGRESSIVE_MAX_DATES). */
  datesAnalyzed: number;
  /** Total de fechas válidas en el rango ANTES del cap — para informar al usuario. */
  totalInRange: number;
  topN: number;
}

export interface ProgressiveSession {
  step: "context" | "start_date" | "end_date" | "strategies" | "confirm";
  context?: StrategyContext;
  startDate?: string;
  endDate?: string;
  selectedIds: Set<string>;
  /** Número de fechas válidas en el rango (calculado al confirmar). */
  estimatedDates?: number;
}

export interface ProgressiveParams {
  startDate: string;
  endDate: string;
  /** Orden de selección determina el orden cumulativo A, B, C… */
  strategyIds: string[];
  context: StrategyContext;
  topN: number;
  fullMap: DateDrawsMap;
  getStrategy: (id: string) => StrategyDefinition | undefined;
  /**
   * Callback de progreso: recibe el porcentaje completado (0-100).
   * Se invoca cada 10% para permitir actualizar la UI sin saturar la API.
   */
  onProgress?: (pct: number) => Promise<void>;
}

/**
 * Calcula cuántas fechas válidas hay en el rango antes de correr el análisis.
 * Útil para estimar tiempo y pedir confirmación al usuario.
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

/**
 * Retorna un Set con los topN números más votados de un mapa de votos.
 * Set en lugar de Array → lookups O(1) en el check de acierto.
 * El mapa tiene max 100 entradas (números 00-99), sort es trivial.
 */
function topNSet(votes: Map<number, number>, topN: number): Set<number> {
  const sorted = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const s = new Set<number>();
  for (let i = 0; i < Math.min(topN, sorted.length); i++) s.add(sorted[i]![0]);
  return s;
}

/** Ejecuta el análisis progresivo y retorna los resultados por subconjunto. */
export async function runProgressiveAnalysis(
  params: ProgressiveParams
): Promise<ProgressiveResult> {
  const { startDate, endDate, strategyIds, context, topN, fullMap, getStrategy, onProgress } = params;

  const startDt = mmddyyToDate(startDate);
  const endDt = mmddyyToDate(endDate);
  if (!startDt || !endDt || startDt > endDt) throw new Error("Rango de fechas inválido");

  const startTime = startDt.getTime();
  const endTime = endDt.getTime();
  const minLen = context.mapSource === "p4" ? 4 : 3;

  // ── Paso 1: Parsear fechas UNA SOLA VEZ ──────────────────────────────────
  // Parsea todos los timestamps de los keys del mapa una única vez y ordena
  // usando esos valores directamente → evita O(m×N) llamadas a mmddyyToDate.
  const rawKeys = Object.keys(fullMap);
  const keyTimeArr = rawKeys.map((k) => ({ k, t: mmddyyToDate(k)?.getTime() ?? 0 }));
  keyTimeArr.sort((a, b) => a.t - b.t);
  const allMapKeys = keyTimeArr.map((x) => x.k);
  /** timestamp por key; acceso O(1) */
  const keyTime = new Map<string, number>(keyTimeArr.map((x) => [x.k, x.t]));

  // ── Paso 2: Fechas válidas para el período/fuente (ya ordenadas) ─────────
  const allValidDates = allMapKeys.filter((d) => {
    const draw = fullMap[d]?.[context.period];
    return draw != null && draw.length >= minLen;
  });
  /** índice de cada fecha válida → next-date lookup O(1) */
  const validIdx = new Map<string, number>(allValidDates.map((d, i) => [d, i]));

  // ── Paso 3: Fechas de corte a iterar ────────────────────────────────────
  const datesInRange = allValidDates.filter(
    (d) => { const t = keyTime.get(d)!; return t >= startTime && t <= endTime; }
  );
  const totalInRange = datesInRange.length;
  const cutoffDates = datesInRange.slice(0, PROGRESSIVE_MAX_DATES);

  // ── Paso 4: Mapa filtrado INCREMENTAL ───────────────────────────────────
  // En lugar de reconstruir el mapa completo en cada iteración (O(m×N)),
  // lo construimos una sola vez y añadimos una entrada por iteración → O(m + N).
  const filteredMap: DateDrawsMap = {};
  let mapPtr = 0;
  // Pre-carga de entradas anteriores a startDate (fuera del loop de corte)
  while (mapPtr < allMapKeys.length && keyTime.get(allMapKeys[mapPtr]!)! < startTime) {
    filteredMap[allMapKeys[mapPtr]!] = fullMap[allMapKeys[mapPtr]!]!;
    mapPtr++;
  }

  // ── Paso 5: Init subconjuntos cumulativos ───────────────────────────────
  const subsets: ProgressiveSubset[] = strategyIds.map((_, i) => ({
    strategyIds: strategyIds.slice(0, i + 1),
    label: Array.from({ length: i + 1 }, (__, j) => String.fromCharCode(65 + j)).join("+"),
    hits: 0,
    misses: 0,
    skipped: 0,
    hitRate: 0,
  }));

  // ── Loop principal ───────────────────────────────────────────────────────
  const total = cutoffDates.length;
  let processed = 0;
  let lastReportedPct = -1;

  for (const cutoffDate of cutoffDates) {
    const cutoffTime = keyTime.get(cutoffDate)!;

    // Avanza el puntero: añade entradas ≤ cutoffDate al mapa filtrado
    while (mapPtr < allMapKeys.length && keyTime.get(allMapKeys[mapPtr]!)! <= cutoffTime) {
      filteredMap[allMapKeys[mapPtr]!] = fullMap[allMapKeys[mapPtr]!]!;
      mapPtr++;
    }

    // Siguiente fecha válida: O(1) con índice precomputado
    const nextDateStr = allValidDates[validIdx.get(cutoffDate)! + 1];
    if (!nextDateStr) { for (const s of subsets) s.skipped++; continue; }

    const nextDraw = fullMap[nextDateStr]?.[context.period];
    if (!nextDraw || nextDraw.length < minLen) { for (const s of subsets) s.skipped++; continue; }

    const actuals = twoDigitNumbers(nextDraw, context.mapSource);
    if (actuals.length === 0) { for (const s of subsets) s.skipped++; continue; }

    // Candidatos de todas las estrategias en paralelo (una vez por fecha de corte)
    const strategyCandidates = await Promise.all(
      strategyIds.map(async (id) => {
        const strat = getStrategy(id);
        if (!strat?.getCandidates) return null;
        try { return await strat.getCandidates(context, filteredMap); } catch { return null; }
      })
    );

    // Evaluación incremental de subconjuntos: acumula votos sin reconstruir
    // el mapa completo en cada subset → O(total_cands) en lugar de O(i × avg_cands)
    const votes = new Map<number, number>();
    for (let i = 0; i < subsets.length; i++) {
      const cands = strategyCandidates[i];
      if (cands != null) {
        for (const n of cands) votes.set(n, (votes.get(n) ?? 0) + 1);
      }

      const subset = subsets[i]!;
      if (votes.size === 0) { subset.skipped++; continue; }

      // Set → .has() O(1) vs array .includes() O(topN)
      const top = topNSet(votes, topN);
      if (actuals.some((a) => top.has(a))) { subset.hits++; } else { subset.misses++; }
    }

    processed++;
    if (onProgress && total > 0) {
      const pct = Math.floor((processed / total) * 100);
      // Notifica cada 10% para no saturar la API de Telegram
      if (pct >= lastReportedPct + 10) {
        lastReportedPct = pct;
        await onProgress(pct);
      }
    }
  }

  for (const s of subsets) {
    const tot = s.hits + s.misses;
    s.hitRate = tot > 0 ? s.hits / tot : 0;
  }

  return { subsets, context, startDate, endDate, datesAnalyzed: cutoffDates.length, totalInRange, topN };
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

  let selectionStatus: string;
  if (selectedIds.size === 0) {
    selectionStatus = "_Sin estrategias seleccionadas (necesitas ≥ 2)_";
  } else if (selectedIds.size === 1) {
    selectionStatus = `_1 estrategia seleccionada (necesitas al menos 2)_`;
  } else if (activeGroup) {
    const group = CONSENSUS_GROUPS.find((g) => g.id === activeGroup);
    selectionStatus = `Grupo *${group?.label ?? activeGroup.toUpperCase()}* — ${selectedIds.size} estrategias`;
  } else {
    selectionStatus = `*${selectedIds.size}* estrategia${selectedIds.size !== 1 ? "s" : ""} seleccionada${selectedIds.size !== 1 ? "s" : ""}`;
  }

  return (
    `📈 *Análisis Progresivo* — ${mapLabel} · ${periodLabel}\n` +
    `📅 \`${startDate}\` → \`${endDate}\`\n\n` +
    `Selecciona las estrategias a evaluar.\n` +
    `El sistema calculará el consenso para cada subconjunto cumulativo:\n` +
    `_A → A+B → A+B+C → …_\n\n` +
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
    const active1 = activeGroup === g1.id ? "✅ " : "";
    kb.text(`${g1.emoji} ${active1}Grupo ${g1.id.toUpperCase()}`, `prog_g_${g1.id}`);
    if (g2) {
      const active2 = activeGroup === g2.id ? "✅ " : "";
      kb.text(`${g2.emoji} ${active2}Grupo ${g2.id.toUpperCase()}`, `prog_g_${g2.id}`);
    }
    kb.row();
  }

  // Seleccionar todo / limpiar
  kb.text("☑️ Seleccionar todas", "prog_all").text("🔲 Limpiar", "prog_none").row();

  // Estrategias individuales
  for (const id of selectableIds) {
    const isSelected = selectedIds.has(id);
    const shortName = id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).slice(0, 16);
    kb.text(`${isSelected ? "✅" : "⬜"} ${shortName}`, `prog_st_${id}`).row();
  }

  // Analizar / cancelar
  if (selectedIds.size >= 2) {
    kb.text(`▶️ Analizar (${selectedIds.size})`, "prog_run").row();
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
    `🔢 *${result.datesAnalyzed}* fechas analizadas${cappedNote} · Top *${result.topN}*`,
    ``,
    `*Leyenda:*`,
  ];

  for (let i = 0; i < Math.min(strategyLabels.length, result.subsets.length); i++) {
    const letter = String.fromCharCode(65 + i);
    lines.push(`  ${letter} = ${strategyLabels[i] ?? result.subsets[i]?.strategyIds.at(-1) ?? "?"}`);
  }

  lines.push(``, "```");
  lines.push(`Combo             Ac/Tot     %`);
  lines.push(`──────────────────────────────`);

  for (const subset of result.subsets) {
    const tot = subset.hits + subset.misses;
    const pct = tot > 0 ? ((subset.hits / tot) * 100).toFixed(1) : "  -";
    const acTot = `${subset.hits}/${tot}`;
    lines.push(
      `${subset.label.padEnd(16)}  ${acTot.padStart(6)}  ${pct.padStart(5)}%`
    );
  }

  lines.push("```");

  const withData = result.subsets.filter((s) => s.hits + s.misses > 0);
  if (withData.length > 0) {
    const best = withData.reduce((a, b) => (a.hitRate >= b.hitRate ? a : b));
    const worst = withData.reduce((a, b) => (a.hitRate <= b.hitRate ? a : b));
    lines.push(``, `🏆 *Mejor:* ${best.label} — ${(best.hitRate * 100).toFixed(1)}%`);
    if (worst.label !== best.label) {
      lines.push(`📉 *Menor:* ${worst.label} — ${(worst.hitRate * 100).toFixed(1)}%`);
    }
  }

  if (result.totalInRange > result.datesAnalyzed) {
    lines.push(
      ``,
      `_⚠️ Se analizaron las primeras ${result.datesAnalyzed} fechas del rango ` +
        `(cap de ${PROGRESSIVE_MAX_DATES}). Ajusta el rango para analizar el resto._`
    );
  }

  const full = lines.join("\n");
  return full.length > 4000 ? full.slice(0, 3985) + "\n\n_… (recortado)_" : full;
}
