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
  /** Descripción corta que explica qué hace la estrategia. Se muestra en el menú de contexto. */
  readonly description?: string;
  /** Mensaje al abrir la estrategia (elegir base, período, etc.). */
  getContextMessage(menuLabel: string, description?: string): string;
  /** Teclado contextual (base P3/P4, período M/E, o opciones propias). */
  buildContextKeyboard(menuId: string): InlineKeyboard;
  /** Ejecuta la estrategia con el mapa ya cargado según context.mapSource. */
  run(context: StrategyContext, map: DateDrawsMap): Promise<string>;
  /**
   * (Opcional) Retorna los N mejores candidatos de esta estrategia como lista
   * de números 00-99. Usado por Consenso Multi-Estrategia para el cruce de datos.
   */
  getCandidates?(context: StrategyContext, map: DateDrawsMap): Promise<number[]>;
}

export const STRATEGY_CONTEXT_CALLBACK_PREFIX = "strat_";

/** 
 * Parsea callback tipo strat_<menuId>_<p3|p4>_<m|e> o strat_<menuId>_<p3|p4>_<m|e>_<limit>.
 * menuId puede contener _ (ej. max_per_week_day) o no (ej. unodostres).
 * limit es opcional (10, 20, 30) para estrategias como unodostres_plus.
 */
export function parseStrategyContextCallback(data: string): { menuId: string; context: StrategyContext } | null {
  if (!data.startsWith(STRATEGY_CONTEXT_CALLBACK_PREFIX)) return null;
  const rest  = data.slice(STRATEGY_CONTEXT_CALLBACK_PREFIX.length);
  const parts = rest.split("_");
  if (parts.length < 3) return null;

  // Detectar sufijo numérico opcional (limit: 10, 20, 30...)
  let limit: number | undefined;
  let searchParts = parts;
  const lastPart = parts[parts.length - 1];
  if (lastPart && /^\d+$/.test(lastPart)) {
    limit       = parseInt(lastPart, 10);
    searchParts = parts.slice(0, -1);
  }

  if (searchParts.length < 3) return null;
  const mapSource = searchParts[searchParts.length - 2];
  const period    = searchParts[searchParts.length - 1];
  if (mapSource !== "p3" && mapSource !== "p4") return null;
  if (period !== "m" && period !== "e") return null;
  const menuId = searchParts.slice(0, -2).join("_");

  return {
    menuId,
    context: {
      mapSource: mapSource as StrategyMapSource,
      period: period as StrategyPeriod,
      ...(limit !== undefined ? { params: { limit } } : {}),
    },
  };
}
