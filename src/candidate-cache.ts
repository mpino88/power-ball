
import { getConsensusSelectableIds, getStrategy, type StrategyDeps } from "./strategies/index.js";

/**
 * Caché de candidatos pre-calculados para evitar fricción y cómputo pesado
 * durante el envío de notificaciones push o refresco del menú "Hoy".
 */
export type CandidateCache = Record<string, number[]>; // key: "source-period-strategyId"

const cache: CandidateCache = {};
let lastWarmUp: number = 0;

/**
 * Retorna el timestamp de la última generación de caché.
 */
export function getLastCacheUpdate(): number {
  return lastWarmUp;
}

/**
 * Genera la llave para el caché.
 * Ejemplo: "p3-m-freq_analysis"
 */
function getCacheKey(source: "p3" | "p4", period: "m" | "e", strategyId: string): string {
  return `${source}-${period}-${strategyId}`;
}

/**
 * Pre-calcula los candidatos para TODAS las estrategias y los almacena en memoria.
 * Permite definir un límite máximo de candidatos por estrategia.
 */
export async function warmUpCandidateCache(deps: StrategyDeps, maxCandidates: number = 20): Promise<void> {
  console.log(`💎 [APEX] Iniciando pre-cálculo de candidatos (Límite: ${maxCandidates})...`);
  lastWarmUp = Date.now();
  
  const strategyIds = getConsensusSelectableIds();
  const sources: ("p3" | "p4")[] = ["p3", "p4"];
  const periods: ("m" | "e")[] = ["m", "e"];
  
  const p3Map = await deps.getP3Map();
  const p4Map = await deps.getP4Map();

  for (const source of sources) {
    const map = source === "p3" ? p3Map : p4Map;
    for (const period of periods) {
      for (const id of strategyIds) {
        const strat = getStrategy(id);
        if (!strat || !strat.getCandidates) continue;

        try {
          const rawCandidates = await strat.getCandidates({ mapSource: source, period }, map);
          // Aplicamos el límite solicitado por el Admin
          const processedCandidates = rawCandidates.slice(0, maxCandidates);
          cache[getCacheKey(source, period, id)] = processedCandidates;
        } catch (e) {
          console.error(`❌ Error pre-calculando candidatos para ${id} (${source}-${period}):`, e);
        }
      }
    }
  }
  
  console.log("✅ [APEX] Caché de candidatos lista. Friction level: 0.");
}

/**
 * Obtiene los candidatos pre-calculados de una estrategia específica.
 */
export function getCachedCandidates(source: "p3" | "p4", period: "m" | "e", strategyId: string): number[] {
  return cache[getCacheKey(source, period, strategyId)] || [];
}

/**
 * Valida si el caché tiene datos para una configuración específica.
 */
export function isCacheReady(source: "p3" | "p4", period: "m" | "e", strategyId: string): boolean {
  return (cache[getCacheKey(source, period, strategyId)]?.length ?? 0) > 0;
}

/**
 * Valida si un número (o lista de números) es un "Hit" contra los candidatos de una estrategia.
 */
export function isStrategyHit(source: "p3" | "p4", period: "m" | "e", strategyId: string, luckyNumbers: number[]): boolean {
  const candidates = getCachedCandidates(source, period, strategyId);
  return luckyNumbers.some(num => candidates.includes(num));
}
