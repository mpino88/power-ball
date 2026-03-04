/**
 * Estrategia 5 — Momentum de Tendencia
 *
 * Compara la frecuencia de aparición en los últimos N sorteos (ventana reciente)
 * contra la frecuencia histórica total. Esto detecta cambios de comportamiento:
 *
 *   Momentum = frecuencia_reciente / frecuencia_histórica
 *
 *   > 1.5x → número en ALZA: aparece más que lo habitual → candidato fuerte
 *   < 0.5x → número en BAJA: ha dejado de salir → posible "enfriamiento"
 *   ≈ 1.0x → comportamiento estable
 *
 * Complementa a freq_analysis: no solo importa cuánto ha salido en total,
 * sino si su tendencia reciente es creciente o decreciente.
 *
 * Id: trend_momentum
 */

import type { StrategyContext, StrategyDefinition, DateDrawsMap } from "./types.js";
import { buildDefaultContextKeyboard, getDefaultContextMessage } from "./context-menu.js";
import { twoDigitNumbers, truncateMsg, validDateKeys } from "./utils.js";

const RECENT_WINDOW = 30;

interface MomentumStat {
  num: number;
  countAll: number;
  countRecent: number;
  freqAll: number;
  freqRecent: number;
  momentum: number;
}

interface MomentumResult {
  stats: MomentumStat[];
  totalAll: number;
  totalRecent: number;
  latestDateStr: string;
}

function computeMomentum(
  map: DateDrawsMap,
  period: "m" | "e",
  mapSource: "p3" | "p4"
): MomentumResult {
  const minLen = mapSource === "p4" ? 4 : 3;
  const allDates = validDateKeys(map, period, mapSource);
  const recentDates = allDates.slice(-RECENT_WINDOW);

  const countAll = new Map<number, number>();
  const countRecent = new Map<number, number>();
  for (let n = 0; n < 100; n++) {
    countAll.set(n, 0);
    countRecent.set(n, 0);
  }

  const accumulate = (dates: string[], target: Map<number, number>) => {
    for (const dateStr of dates) {
      const draw = map[dateStr]?.[period];
      if (!draw || draw.length < minLen) continue;
      for (const num of twoDigitNumbers(draw, mapSource)) {
        if (num >= 0 && num <= 99) target.set(num, (target.get(num) ?? 0) + 1);
      }
    }
  };

  accumulate(allDates, countAll);
  accumulate(recentDates, countRecent);

  const totalAll = allDates.length;
  const totalRecent = recentDates.length;

  const stats: MomentumStat[] = [];
  for (let n = 0; n < 100; n++) {
    const ca = countAll.get(n) ?? 0;
    const cr = countRecent.get(n) ?? 0;
    const fa = totalAll > 0 ? ca / totalAll : 0;
    const fr = totalRecent > 0 ? cr / totalRecent : 0;
    // If historically 0 but now appearing: strong new signal
    const momentum = fa > 0 ? fr / fa : cr > 0 ? 10 : 0;
    stats.push({ num: n, countAll: ca, countRecent: cr, freqAll: fa, freqRecent: fr, momentum });
  }

  const latestDateStr = allDates.at(-1) ?? "";
  return { stats, totalAll, totalRecent, latestDateStr };
}

function formatMessage(
  { stats, totalAll, totalRecent, latestDateStr }: MomentumResult,
  mapSource: "p3" | "p4",
  period: "m" | "e"
): string {
  const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  // Rising: filter out noise (need at least 3 historical appearances)
  const rising = [...stats]
    .filter((s) => s.countAll >= 3)
    .sort((a, b) => b.momentum - a.momentum)
    .slice(0, 15);

  const falling = [...stats]
    .filter((s) => s.countAll >= 5)
    .sort((a, b) => a.momentum - b.momentum)
    .slice(0, 10);

  const momentumLabel = (m: number) => {
    if (m >= 3.0) return "↑↑↑";
    if (m >= 1.5) return "↑↑ ";
    if (m >= 1.0) return "↑  ";
    if (m === 0) return "— ";
    return "↓  ";
  };

  const lines: string[] = [
    `📊 *Momentum de Tendencia* — ${mapLabel} · ${periodLabel}`,
    `Histórico: ${totalAll} sorteos · Reciente: últimos ${totalRecent} sorteos · Último: ${latestDateStr}`,
    "",
    "📖 _Qué mide:_ detecta cambios de comportamiento recientes vs la tendencia histórica total\\.",
    "_Rec\\._ = freq\\. últimos 30 · _Hist\\._ = freq\\. total · _Momento_ = Rec÷Hist \\(>1x = en alza\\)",
    "→ ↑↑↑ ≥3x alza fuerte · ↑↑ ≥1\\.5x alza · ↓ en baja · Complementa al Análisis de Frecuencia",
    "",
    "```",
    "📈 TOP 15 EN ALZA",
    "Num  Rec.   Hist.   Moment.",
    "────────────────────────────",
  ];

  for (const s of rising) {
    const n = String(s.num).padStart(2, "0");
    const fr = `${(s.freqRecent * 100).toFixed(1)}%`.padStart(6);
    const fa = `${(s.freqAll * 100).toFixed(1)}%`.padStart(6);
    const ml = momentumLabel(s.momentum);
    const mv = s.momentum >= 10 ? "nuevo↑" : `${s.momentum.toFixed(1)}x`;
    lines.push(`${n}   ${fr}  ${fa}  ${mv.padStart(6)} ${ml}`);
  }

  lines.push("");
  lines.push("📉 TOP 10 EN BAJA");
  lines.push("Num  Rec.   Hist.   Moment.");
  lines.push("────────────────────────────");

  for (const s of falling) {
    const n = String(s.num).padStart(2, "0");
    const fr = `${(s.freqRecent * 100).toFixed(1)}%`.padStart(6);
    const fa = `${(s.freqAll * 100).toFixed(1)}%`.padStart(6);
    const ml = momentumLabel(s.momentum);
    const mv = `${s.momentum.toFixed(1)}x`;
    lines.push(`${n}   ${fr}  ${fa}  ${mv.padStart(6)} ${ml}`);
  }

  lines.push("");
  lines.push("↑↑↑ ≥3x alza fuerte · ↑↑ ≥1.5x alza · ↓ baja");
  lines.push("```");

  return truncateMsg(lines.join("\n").trimEnd());
}

export const trendMomentum: StrategyDefinition = {
  id: "trend_momentum",
  getContextMessage: getDefaultContextMessage,
  buildContextKeyboard: buildDefaultContextKeyboard,
  async run(context: StrategyContext, map: DateDrawsMap): Promise<string> {
    const result = computeMomentum(map, context.period, context.mapSource);
    return formatMessage(result, context.mapSource, context.period);
  },
};
