/**
 * Tipos para el motor de estrategias: contexto, definición por estrategia y mapa de conocimientos.
 */

import type { InlineKeyboard } from "grammy";

/** Mapa de conocimientos: fecha MM/DD/YY → sorteos Mediodía/Noche (arrays de 3 o 4 dígitos). */
export type DateDrawsMap = Record<string, { m?: number[]; e?: number[] }>;

/** Base de conocimientos: mapa de fechas P3 (Fijos) o P4 (Corridos). */
export type StrategyMapSource = "p3" | "p4";

/** Período del sorteo: Mediodía (Día) o Noche (Evening). */
export type StrategyPeriod = "m" | "e";

export interface StrategyContext {
  mapSource: StrategyMapSource;
  period: StrategyPeriod;
  /** Parámetros adicionales por estrategia (ej. días de historial, filtros). */
  params?: Record<string, unknown>;
}

/**
 * Definición de una estrategia: id, menú contextual y resolución.
 * Cada estrategia vive en su propio archivo y se registra en el motor.
 */
export interface StrategyDefinition {
  readonly id: string;
  /** Mensaje al abrir la estrategia (elegir base, período, etc.). */
  getContextMessage(menuLabel: string): string;
  /** Teclado contextual (base P3/P4, período M/E, o opciones propias). */
  buildContextKeyboard(menuId: string): InlineKeyboard;
  /** Ejecuta la estrategia con el mapa ya cargado según context.mapSource. */
  run(context: StrategyContext, map: DateDrawsMap): Promise<string>;
}

export const STRATEGY_CONTEXT_CALLBACK_PREFIX = "strat_";

/** Parsea callback tipo strat_<menuId>_<p3|p4>_<m|e>. menuId puede contener _ (ej. estrategia_test). */
export function parseStrategyContextCallback(data: string): { menuId: string; context: StrategyContext } | null {
  if (!data.startsWith(STRATEGY_CONTEXT_CALLBACK_PREFIX)) return null;
  const rest = data.slice(STRATEGY_CONTEXT_CALLBACK_PREFIX.length);
  const parts = rest.split("_");
  if (parts.length < 4) return null;
  const mapSource = parts[parts.length - 2];
  const period = parts[parts.length - 1];
  if (mapSource !== "p3" && mapSource !== "p4") return null;
  if (period !== "m" && period !== "e") return null;
  const menuId = parts.slice(0, -2).join("_");
  return {
    menuId,
    context: { mapSource: mapSource as StrategyMapSource, period: period as StrategyPeriod },
  };
}
