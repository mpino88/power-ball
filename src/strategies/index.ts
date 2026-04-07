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

import { decadeFamily } from "./decade-family.js";
import { mirrorComplement } from "./mirror-complement.js";
import { terminalAnalysis } from "./terminal-analysis.js";
import { cycleDetector } from "./cycle-detector.js";
import { streakAnalysis } from "./streak-analysis.js";
import { bayesianScore } from "./bayesian-score.js";
import { unodostres } from "./unodostres.js";
import { unodostresPlus } from "./unodostres-plus.js";
import * as ballBacktest from "./ball-backtest.js";

export type { DateDrawsMap, StrategyContext, StrategyDefinition, StrategyMapSource, StrategyPeriod } from "./types.js";
export { parseStrategyContextCallback, STRATEGY_CONTEXT_CALLBACK_PREFIX } from "./types.js";
export { ballBacktest };
export { buildBBTStrategyMessage, buildBBTResultMessage } from "./ball-backtest.js";

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

import { escapeMd } from "../security/callbacks.js";

import { getExtraMenuDescription } from "../menu-registry.js";

export function getStrategyContextMessage(menuId: string, menuLabel: string): string {
  const s = registry.get(menuId);
  if (!s) return `Estrategia _${menuId}_ no encontrada.`;
  // Usar la descripción de StrategyDefinition, o si no la hay, ver en menu-registry (estrategias extra)
  let desc = s.description || getExtraMenuDescription(menuId);
  if (desc) desc = escapeMd(desc);
  return s.getContextMessage(menuLabel, desc);
}

export async function runStrategy(
  menuId: string,
  context: StrategyContext,
  deps: StrategyDeps
): Promise<string> {
  const s = registry.get(menuId);
  if (!s) return `Estrategia _${menuId}_ no implementada.`;
  const map = context.mapSource === "p3" ? await deps.getP3Map() : await deps.getP4Map();
  
  let result = await s.run(context, map);

  const targetStrategies = [
    "max_per_week_day", "freq_analysis", "gap_due", "calendar_pattern",
    "transition_follow", "trend_momentum", "positional_analysis",
    "consensus_multi", "est_individuales", "markov_order2",
    "decade_family", "mirror_complement", "terminal_analysis",
    "cycle_detector", "streak_analysis", "bayesian_score",
    "unodostres", "unodostres_plus"
  ];

  if (targetStrategies.includes(menuId) && s.getCandidates) {
    try {
      const candidates = await s.getCandidates(context, map);
      if (candidates && candidates.length > 0) {
        const formatted = candidates.map(c => String(c).padStart(2, "0")).join(", ");
        // Cerrar cualquier bloque de código si hubiera sido truncado
        const ticksCount = (result.match(/```/g) || []).length;
        if (ticksCount % 2 !== 0) {
             result += "\n```\n";
        }
        result += `\n\n🎯 *Candidatos tipo:* ${formatted}`;
      } else {
        result += `\n\n🎯 *Candidatos tipo:* (Vacío - Sin resultados detectados)`;
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      result += `\n\n⚠️ *Error obteniendo candidatos:* ${errMsg}`;
      console.error(`Error appending candidates for strategy ${menuId}:`, e);
    }
  } else if (!targetStrategies.includes(menuId)) {
    // Para ver si el IDs son exactamente como creemos
    result += `\n\n_Nota interna: Estrategia ${menuId} no listada en targetStrategies_`;
  } else if (!s.getCandidates) {
    result += `\n\n_Nota interna: Estrategia ${menuId} no implementa getCandidates()_`;
  }

  return result;
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

registerStrategy(decadeFamily);
registerStrategy(mirrorComplement);
registerStrategy(terminalAnalysis);
registerStrategy(cycleDetector);
registerStrategy(streakAnalysis);
registerStrategy(bayesianScore);
registerStrategy(unodostres);
registerStrategy(unodostresPlus);
// —— Meta-estrategia (siempre al final) ——
registerStrategy(consensusMulti);
