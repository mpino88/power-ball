/**
 * Motor de estrategias: registro por strategy_id y ejecución según contexto.
 * Cada estrategia se implementa en su propio archivo y se registra aquí.
 */

import { InlineKeyboard } from "grammy";
import type { DateDrawsMap, StrategyContext, StrategyDefinition } from "./types.js";
import { maxPerWeekDay } from "./max-per-week-day.js";

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

// —— Registro de estrategias (añadir una línea por cada nueva estrategia) ——
registerStrategy(maxPerWeekDay);
