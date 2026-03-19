import { getConsensusSelectableIds, getStrategy, type StrategyDeps } from "./strategies/index.js";
import { computeStatsCombined, getTop10HottestIndividual } from "./stats-p3.js";
import { getHoyResult } from "./hoy-results.js";
import { twoDigitNumbers } from "./strategies/utils.js";
import { isStrategyHit, isCacheReady } from "./candidate-cache.js";

export interface WinningStrategy {
  id: string;
  label: string;
}

/**
 * Motor de detección de "Hits" (Aciertos) para Neuromarketing.
 * Analiza qué estrategias o estadísticas 'calientes' coincidieron con el resultado de hoy.
 * Utiliza el caché de candidatos para eliminar fricción y latencia.
 */
export async function findWinningStrategies(
  deps: StrategyDeps,
  hotThreshold: number,
  customResults?: { p3_m?: string; p3_e?: string; p4_m?: string; p4_e?: string }
): Promise<{ p3_m: WinningStrategy[]; p3_e: WinningStrategy[]; p4_m: WinningStrategy[]; p4_e: WinningStrategy[] }> {
  const hoyData = customResults || getHoyResult();
  
  const parseToDigits = (v?: string): number[] | null => {
    if (!v) return null;
    return v.split("").map(n => parseInt(n, 10));
  };

  const resultsDraws = {
    p3_m: parseToDigits(hoyData.p3_m),
    p3_e: parseToDigits(hoyData.p3_e),
    p4_m: parseToDigits(hoyData.p4_m),
    p4_e: parseToDigits(hoyData.p4_e),
  };

  const winning: Record<keyof typeof resultsDraws, WinningStrategy[]> = {
    p3_m: [],
    p3_e: [],
    p4_m: [],
    p4_e: [],
  };

  const strategyIds = getConsensusSelectableIds();
  const p3Map = await deps.getP3Map();
  const p4Map = await deps.getP4Map();

  // 1. Auditoría de Estrategias (Basada en Caché - 0 Latencia con Fallback de Resiliencia)
  const checkStrategies = async (source: "p3" | "p4", period: "m" | "e", key: keyof typeof resultsDraws) => {
    const draw = resultsDraws[key];
    if (!draw) return;

    const luckyNumbers = twoDigitNumbers(draw, source);
    if (luckyNumbers.length === 0) return;

    for (const id of strategyIds) {
      let isHit = false;
      
      // Intentamos usar el caché (Rápido)
      if (isCacheReady(source, period, id)) {
        isHit = isStrategyHit(source, period, id, luckyNumbers);
      } else {
        // FALLBACK: Si no hay caché, calculamos on-the-fly para no perder el Social Proof
        const strat = getStrategy(id);
        if (strat && strat.getCandidates) {
          const map = source === "p3" ? p3Map : p4Map;
          try {
            const candidates = await strat.getCandidates({ mapSource: source, period }, map);
            isHit = luckyNumbers.some(num => candidates.includes(num));
          } catch (e) {
            console.error(`[resilience] Fallback failed for ${id}:`, e);
          }
        }
      }

      if (isHit) {
        winning[key].push({ id, label: id });
      }
    }
  };

  await checkStrategies("p3", "m", "p3_m");
  await checkStrategies("p3", "e", "p3_e");
  await checkStrategies("p4", "m", "p4_m");
  await checkStrategies("p4", "e", "p4_e");

  // 2. Auditoría de Estadísticas de Grupos (P3 y P4 2x2 Split)
  const checkStats = (period: "m" | "e", key: keyof typeof resultsDraws, source: "p3" | "p4") => {
    const draw = resultsDraws[key];
    if (!draw) return;
    
    // Deep Audit: Extraemos todos los pares (1 para P3, 2 para P4)
    const luckyNumbers = twoDigitNumbers(draw, source);
    if (luckyNumbers.length === 0) return;

    const map = source === "p3" ? p3Map : p4Map;
    const stats = computeStatsCombined(map, period === "m" ? "M" : "E", source);

    for (const luckyNum of luckyNumbers) {
      const terminal = luckyNum % 10;
      const inicial = Math.floor(luckyNum / 10);
      const isDouble = luckyNum % 11 === 0;

      // Terminal Hot?
      const t = stats.groups.terminales[terminal]!;
      if (t.currentGapDays !== null && t.maxGapDays - t.currentGapDays <= hotThreshold) {
        const label = source === "p4" ? `T${terminal} (en ${luckyNum})` : `Terminal ${terminal}`;
        winning[key].push({ id: `stat_terminal_${luckyNum}`, label });
      }
      
      // Inicial Hot?
      const i = stats.groups.iniciales[inicial]!;
      if (i.currentGapDays !== null && i.maxGapDays - i.currentGapDays <= hotThreshold) {
        const label = source === "p4" ? `I${inicial} (en ${luckyNum})` : `Inicial ${inicial}`;
        winning[key].push({ id: `stat_inicial_${luckyNum}`, label });
      }
      
      // Dobles Hot?
      if (isDouble) {
        const d = stats.groups.dobles;
        if (d.currentGapDays !== null && d.maxGapDays - d.currentGapDays <= hotThreshold) {
          const label = source === "p4" ? `Doble ${luckyNum}` : "Dobles";
          winning[key].push({ id: `stat_doble_${luckyNum}`, label });
        }
      }

      // Individual Hot?
      const top10 = getTop10HottestIndividual(stats.individual);
      if (top10.some(h => h.num === luckyNum && (h.maxGapDays - h.currentGapDays <= hotThreshold))) {
        winning[key].push({ id: `stat_individual_${luckyNum}`, label: `Est. Individual (${luckyNum})` });
      }
    }
  };

  checkStats("m", "p3_m", "p3");
  checkStats("e", "p3_e", "p3");
  checkStats("m", "p4_m", "p4");
  checkStats("e", "p4_e", "p4");

  return winning;
}

