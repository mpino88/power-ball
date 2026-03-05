/**
 * Motor de estrategias: registro por strategy_id y ejecución según contexto.
 * Cada estrategia se implementa en su propio archivo y se registra aquí.
 */

import { InlineKeyboard } from "grammy";
import type { DateDrawsMap, StrategyContext, StrategyDefinition } from "./types.js";
import { maxPerWeekDay } from "./max-per-week-day.js";
import { freqAnalysis } from "./freq-analysis.js";
import { gapDue } from "./gap-due.js";
import { calendarPattern } from "./calendar-pattern.js";
import { transitionFollow } from "./transition-follow.js";
import { trendMomentum } from "./trend-momentum.js";
import { positionalAnalysis } from "./positional-analysis.js";
import { estIndividuales } from "./est-individuales.js";
import { consensusMulti } from "./consensus-multi.js";
import { markovOrder2 } from "./markov-order2.js";
import { maxGapBreach } from "./max-gap-breach.js";
import { decadeFamily } from "./decade-family.js";
import { mirrorComplement } from "./mirror-complement.js";
import { terminalAnalysis } from "./terminal-analysis.js";
import { cycleDetector } from "./cycle-detector.js";
import { streakAnalysis } from "./streak-analysis.js";
import { bayesianScore } from "./bayesian-score.js";

export type { DateDrawsMap, StrategyContext, StrategyDefinition, StrategyMapSource, StrategyPeriod } from "./types.js";
export { parseStrategyContextCallback, STRATEGY_CONTEXT_CALLBACK_PREFIX } from "./types.js";

export interface StrategyDeps {
  getP3Map: () => Promise<DateDrawsMap>;
  getP4Map: () => Promise<DateDrawsMap>;
}

const registry = new Map<string, StrategyDefinition>();

export function registerStrategy(def: StrategyDefinition): void {
  registry.set(def.id, def);
}

export function getStrategy(id: string): StrategyDefinition | undefined {
  return registry.get(id);
}

export function hasStrategyRunner(menuId: string): boolean {
  return registry.has(menuId);
}

export function buildStrategyContextKeyboard(menuId: string): InlineKeyboard {
  const s = registry.get(menuId);
  return s ? s.buildContextKeyboard(menuId) : new InlineKeyboard().text("◀️ Volver", "volver");
}

export function getStrategyContextMessage(menuId: string, menuLabel: string): string {
  const s = registry.get(menuId);
  return s ? s.getContextMessage(menuLabel) : `Estrategia _${menuId}_ no encontrada.`;
}

export async function runStrategy(
  menuId: string,
  context: StrategyContext,
  deps: StrategyDeps
): Promise<string> {
  const s = registry.get(menuId);
  if (!s) return `Estrategia _${menuId}_ no implementada.`;
  const map = context.mapSource === "p3" ? await deps.getP3Map() : await deps.getP4Map();
  return s.run(context, map);
}

/**
 * Retorna los IDs de todas las estrategias registradas que implementan `getCandidates`
 * (excluyendo `consensus_multi`).
 *
 * ── CONVENCIÓN ──────────────────────────────────────────────────────────────
 * Para que una nueva estrategia sea SELECCIONABLE en Consenso Multi-Estrategia,
 * basta con que implemente el método opcional `getCandidates` en su objeto
 * `StrategyDefinition`. No hay que tocar ningún archivo adicional; el sistema
 * la detecta automáticamente en tiempo de ejecución.
 *
 *   getCandidates(context, map): Promise<number[]>
 *
 * El método debe devolver una lista ordenada (de más a menos probable) de
 * números 00-99 que la estrategia considera candidatos para el próximo sorteo.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function getConsensusSelectableIds(): string[] {
  return [...registry.entries()]
    .filter(([id, s]) => id !== "consensus_multi" && typeof s.getCandidates === "function")
    .map(([id]) => id);
}

// —— Registro de estrategias (añadir una línea por cada nueva estrategia) ——
registerStrategy(maxPerWeekDay);
registerStrategy(freqAnalysis);
registerStrategy(gapDue);
registerStrategy(calendarPattern);
registerStrategy(transitionFollow);
registerStrategy(trendMomentum);
registerStrategy(positionalAnalysis);
registerStrategy(estIndividuales);
// —— Nuevas estrategias (v2) ——
registerStrategy(markovOrder2);
registerStrategy(maxGapBreach);
registerStrategy(decadeFamily);
registerStrategy(mirrorComplement);
registerStrategy(terminalAnalysis);
registerStrategy(cycleDetector);
registerStrategy(streakAnalysis);
registerStrategy(bayesianScore);
// —— Meta-estrategia (siempre al final) ——
registerStrategy(consensusMulti);
