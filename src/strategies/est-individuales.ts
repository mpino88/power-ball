/**
 * Est. Individuales — Top 10 más Hot (números 00-99, 2 últimos dígitos P3).
 *
 * Analiza los 100 números posibles (00-99) comparando cuánto llevan sin salir
 * (Máx.actual) respecto al máximo histórico de días sin salir (Máx.hist).
 * Un número con Máx.hist − Máx.actual pequeño está "caliente" (hot).
 *
 * Solo aplica a P3 (Fijo). Para P4 devuelve aviso.
 *
 * Id: est_individuales
 */

import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";
import { computeStatsCombined, getTop10HottestIndividual, buildIndividualTop10Message } from "../stats-p3.js";
import { getDateRangeStr } from "./utils.js";

const DEFAULT_DIAS_DIFERENCIA = 5;

export const estIndividuales: StrategyDefinition = {
  id: "est_individuales",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,

  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    if (context.mapSource !== "p3") {
      const periodLabel = context.period === "m" ? "☀️ Mediodía" : "🌙 Noche";
      return (
        `📈 *Est. Individuales* — P4 · ${periodLabel}\n\n` +
        `_Esta estrategia analiza los 2 últimos dígitos de sorteos Fijo (P3). No aplica para Corrido (P4)._\n\n` +
        `Usa el contexto *P3 (Fijo)* para ver el Top 10 más Hot.`
      );
    }
    const period = context.period === "m" ? "M" : "E";
    const rangeStr = getDateRangeStr(map, context.period, context.mapSource);
    const msg = buildIndividualTop10Message(map, DEFAULT_DIAS_DIFERENCIA, period);
    return `${msg}\n_Período: ${rangeStr}_`;
  },

  async getCandidates(context: StrategyContext, map: DateDrawsMap): Promise<number[]> {
    if (context.mapSource !== "p3") return [];
    const period = context.period === "m" ? "M" : "E";
    const { individual: stats } = computeStatsCombined(map, period);
    return getTop10HottestIndividual(stats).map((r) => r.num);
  },
};
