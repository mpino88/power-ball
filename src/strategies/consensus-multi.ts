/**
 * Estrategia 9 — Consenso Multi-Estrategia
 *
 * Meta-estrategia interactiva: el usuario selecciona varias estrategias,
 * el sistema extrae los mejores candidatos de cada una bajo el mismo contexto
 * (P3/P4 · Día/Noche) y muestra los N números con mayor respaldo cruzado.
 *
 * Flujo: selección interactiva (cns_t_<id>) → confirmación (cns_ok) →
 * entrada de cantidad (texto libre 1-20) → resultado con análisis cruzado.
 *
 * ── PARA AGREGAR UNA NUEVA ESTRATEGIA AL CONSENSO ────────────────────────────
 * Solo implementa `getCandidates` en su StrategyDefinition:
 *
 *   async getCandidates(context, map): Promise<number[]> { ... }
 *
 * Devuelve una lista ordenada de números 00-99 (más probable primero).
 * El sistema la detecta automáticamente — no hay que modificar este archivo.
 *
 * Opcionalmente, añade una entrada en STRATEGY_META (abajo) para personalizar
 * el emoji, nombre corto y descripción que aparece en la pantalla de selección.
 * Si no se añade, se usan valores por defecto derivados del id.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Id: consensus_multi
 */

import { InlineKeyboard } from "grammy";
import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";
import { validDateKeys, DAY_NAMES, MONTH_NAMES, mmddyyToDate } from "./utils.js";

// ─── Meta-data de cada estrategia para display y explicación ─────────────────
// Añade aquí una entrada cuando implementes una nueva estrategia para
// personalizar su representación en el selector de Consenso.
// Si no añades entrada, se usará el fallback genérico (ver getStrategyMeta).

interface StrategyMeta {
  emoji: string;
  shortName: string;
  fullName: string;
  candidateDesc: (ctx: StrategyContext, nextDate: Date | null) => string;
}

const STRATEGY_META: Record<string, StrategyMeta> = {
  freq_analysis: {
    emoji: "📊",
    shortName: "Frec",
    fullName: "Análisis de Frecuencia",
    candidateDesc: () => "top 20 con mayor aparición histórica",
  },
  gap_due: {
    emoji: "⏳",
    shortName: "Gap",
    fullName: "Números Debidos (Gap)",
    candidateDesc: () => "top 20 atrasados vs su promedio histórico",
  },
  calendar_pattern: {
    emoji: "📅",
    shortName: "Cal",
    fullName: "Patrón Calendario",
    candidateDesc: (_, nextDate) =>
      nextDate
        ? `candidatos para ${DAY_NAMES[nextDate.getDay()]} ${nextDate.getDate()} de ${MONTH_NAMES[nextDate.getMonth()]}`
        : "candidatos según patrón de fecha",
  },
  transition_follow: {
    emoji: "🔗",
    shortName: "Seq",
    fullName: "Seguidor de Secuencias",
    candidateDesc: () => "sucesores más probables del último sorteo (Markov)",
  },
  trend_momentum: {
    emoji: "📈",
    shortName: "Trend",
    fullName: "Momentum de Tendencia",
    candidateDesc: () => "top 20 números con momentum reciente en alza",
  },
  max_per_week_day: {
    emoji: "📆",
    shortName: "DíaSem",
    fullName: "Más salidores x día",
    candidateDesc: (_, nextDate) =>
      nextDate
        ? `top 10 histórico para los ${DAY_NAMES[nextDate.getDay()]}s`
        : "top 10 por día de semana",
  },
  positional_analysis: {
    emoji: "🔢",
    shortName: "Pos",
    fullName: "Análisis Posicional",
    candidateDesc: (ctx) =>
      ctx.mapSource === "p3"
        ? "pares más probables por combinación posicional (centena×decena, decena×unidad)"
        : "top pares [AB] y [CD] más frecuentes por posición",
  },
  est_individuales: {
    emoji: "🔥",
    shortName: "Hot",
    fullName: "Est. Individuales (Hot)",
    candidateDesc: (ctx) =>
      ctx.mapSource === "p3"
        ? "top 10 números 00-99 más calientes (más cerca de su máximo histórico sin salir)"
        : "solo aplica a P3 — sin candidatos para P4",
  },
};

/**
 * Retorna el meta de una estrategia. Si no tiene entrada en STRATEGY_META,
 * genera valores por defecto a partir del id para que cualquier nueva estrategia
 * que implemente getCandidates aparezca correctamente en el selector sin
 * necesidad de modificar este archivo.
 */
function getStrategyMeta(id: string, ctx: StrategyContext, nextDate: Date | null): StrategyMeta {
  if (STRATEGY_META[id]) return STRATEGY_META[id]!;
  // Fallback genérico: capitaliza el id y usa emoji neutro
  const fallbackName = id.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return {
    emoji: "🎲",
    shortName: id.slice(0, 7),
    fullName: fallbackName,
    candidateDesc: () => "candidatos de esta estrategia",
  };
}

// ─── UI helpers ──────────────────────────────────────────────────────────────

/**
 * Construye el mensaje de selección de estrategias.
 * @param selectableIds Lista dinámica de IDs seleccionables (de getConsensusSelectableIds).
 */
export function buildConsensusSelectionMessage(
  selectedCount: number,
  context: StrategyContext,
  selectableIds: string[]
): string {
  const mapLabel = context.mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";
  const periodLabel = context.period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const total = selectableIds.length;

  const lines = [
    `🤝 *Consenso Multi-Estrategia* — ${mapLabel} · ${periodLabel}`,
    "",
    `Selecciona las estrategias a cruzar _(${selectedCount}/${total} seleccionadas)_:`,
    "",
    "📖 _Cómo funciona:_ cada estrategia aportará su lista de candidatos.",
    "Los números que más estrategias avalen serán los resultados finales.",
    "",
    selectedCount === 0
      ? "⬜ Ninguna seleccionada — elige al menos 1."
      : `✅ ${selectedCount} estrategia(s) activa(s). Pulsa *Listo* para continuar.`,
  ];
  return lines.join("\n");
}

/**
 * Construye el teclado de selección de estrategias.
 * @param selectableIds Lista dinámica de IDs seleccionables (de getConsensusSelectableIds).
 */
export function buildConsensusSelectionKeyboard(
  selectedIds: Set<string>,
  context: StrategyContext,
  selectableIds: string[]
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const id of selectableIds) {
    const meta = getStrategyMeta(id, context, null);
    const selected = selectedIds.has(id);
    const mark = selected ? "✅" : "⬜";
    kb.text(`${mark} ${meta.emoji} ${meta.fullName}`, `cns_t_${id}`).row();
  }

  const count = selectedIds.size;
  const listoLabel =
    count === 0
      ? "✅ Listo (selecciona ≥1)"
      : `✅ Listo (${count} seleccionada${count > 1 ? "s" : ""})`;

  kb.text(listoLabel, "cns_ok").row();
  kb.text("❌ Cancelar", "cns_x");
  return kb;
}

// ─── Aggregation logic ───────────────────────────────────────────────────────

type StrategyGetter = (
  id: string
) => { getCandidates?: (ctx: StrategyContext, map: DateDrawsMap) => Promise<number[]> } | undefined;

export async function runConsensusAggregation(
  context: StrategyContext,
  selectedIds: string[],
  count: number,
  map: DateDrawsMap,
  getStrategy: StrategyGetter
): Promise<string> {
  if (selectedIds.length === 0) return "❌ No se seleccionó ninguna estrategia.";

  // Compute next estimated date from latest entry in map
  const dates = validDateKeys(map, context.period, context.mapSource);
  const latestKey = dates.at(-1);
  const latestDate = latestKey ? mmddyyToDate(latestKey) : null;
  const nextDate = latestDate ? new Date(latestDate.getTime() + 86_400_000) : null;

  // Gather candidates per strategy
  const candidatesPerStrategy = new Map<string, number[]>();
  for (const id of selectedIds) {
    const strat = getStrategy(id);
    if (!strat?.getCandidates) {
      candidatesPerStrategy.set(id, []);
      continue;
    }
    try {
      const list = await strat.getCandidates(context, map);
      candidatesPerStrategy.set(id, list);
    } catch {
      candidatesPerStrategy.set(id, []);
    }
  }

  // Vote counting: each strategy casts 1 vote per candidate
  const votes = new Map<number, number>();
  const voterIds = new Map<number, string[]>(); // num → strategy short-names
  for (const id of selectedIds) {
    const meta = getStrategyMeta(id, context, nextDate);
    const candidates = candidatesPerStrategy.get(id) ?? [];
    for (const num of candidates) {
      votes.set(num, (votes.get(num) ?? 0) + 1);
      if (!voterIds.has(num)) voterIds.set(num, []);
      voterIds.get(num)!.push(meta.shortName);
    }
  }

  // Sort by votes desc
  const ranked = [...votes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count);

  const total = selectedIds.length;
  const mapLabel = context.mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";
  const periodLabel = context.period === "m" ? "☀️ Mediodía" : "🌙 Noche";

  const latestStr = latestKey ?? "N/D";
  const nextStr = nextDate
    ? `${String(nextDate.getMonth() + 1).padStart(2, "0")}/${String(nextDate.getDate()).padStart(2, "0")}/${String(nextDate.getFullYear()).slice(-2)} (${DAY_NAMES[nextDate.getDay()]}, ${MONTH_NAMES[nextDate.getMonth()]})`
    : "N/D";

  const lines: string[] = [];

  // Header
  lines.push(`🎯 *Consenso Multi-Estrategia* — ${mapLabel} · ${periodLabel}`);
  lines.push(`Cruce de *${total}* estrategia${total > 1 ? "s" : ""} · Top *${count}* resultado${count > 1 ? "s" : ""}`);
  lines.push(`Último: ${latestStr} · Próx. estimado: ${nextStr}`);
  lines.push("");

  // Dynamic methodology explanation
  lines.push("📖 _Metodología de análisis cruzado:_");
  lines.push(
    `Se ejecutaron *${total}* estrategia${total > 1 ? "s" : ""} en paralelo bajo el mismo contexto`
  );
  lines.push(`_(${mapLabel} · ${periodLabel})_ y se compararon sus listas de candidatos.`);
  lines.push("");
  for (const id of selectedIds) {
    const meta = getStrategyMeta(id, context, nextDate);
    const desc = meta.candidateDesc(context, nextDate);
    lines.push(`· ${meta.emoji} *${meta.shortName}* — ${desc}`);
  }
  lines.push("");
  lines.push(
    `Cada número recibe *1 voto* por cada estrategia que lo incluye entre sus candidatos.`
  );
  lines.push("Mayor cantidad de votos = mayor respaldo estadístico cruzado.");
  lines.push("");

  // Results table
  lines.push("```");
  lines.push(`TOP ${count} — CONSENSO CRUZADO (${total} estrategia${total > 1 ? "s" : ""})`);
  const sep = "─".repeat(44);
  lines.push(sep);
  lines.push("Num  Votos  Respaldo         Avalado por");
  lines.push(sep);

  for (const [num, v] of ranked) {
    const numStr = String(num).padStart(2, "0");
    const votesStr = `${v}/${total}`.padStart(5);
    const pct = ((v / total) * 100).toFixed(0);
    const bar = "█".repeat(v).padEnd(total, " ");
    const pctStr = `${pct}%`.padStart(4);
    const voters = (voterIds.get(num) ?? []).join("·");
    lines.push(` ${numStr}   ${votesStr}   ${bar} ${pctStr}  ${voters}`);
  }
  lines.push(sep);
  lines.push("```");

  // Per-strategy candidates summary
  lines.push("");
  lines.push("_Candidatos por estrategia:_");
  lines.push("```");
  for (const id of selectedIds) {
    const meta = getStrategyMeta(id, context, nextDate);
    const cands = (candidatesPerStrategy.get(id) ?? []).slice(0, 12);
    const numsStr = cands.map((n) => String(n).padStart(2, "0")).join(" ");
    const label = `${meta.shortName}:`.padEnd(9);
    lines.push(`${label} ${numsStr || "(sin datos)"}`);
  }
  lines.push("```");

  const full = lines.join("\n");
  return full.length > 4000 ? full.slice(0, 3990) + "\n\n_… (recortado)_" : full;
}

// ─── StrategyDefinition ──────────────────────────────────────────────────────

export const consensusMulti: StrategyDefinition = {
  id: "consensus_multi",
  getContextMessage(menuLabel: string): string {
    return getDefaultContextMessage(menuLabel);
  },
  buildContextKeyboard(menuId: string): InlineKeyboard {
    return buildDefaultContextKeyboard(menuId);
  },
  async run(_context: StrategyContext, _map: DateDrawsMap): Promise<string> {
    // The interactive multi-step flow is managed in bot.ts.
    // This fallback is shown only if run() is called directly (should not happen).
    return "⚠️ Esta estrategia requiere el flujo interactivo. Accede desde el menú de Estrategias.";
  },
};
