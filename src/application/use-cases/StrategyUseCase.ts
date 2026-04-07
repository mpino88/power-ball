import { IStrategyRepository } from "../../domain/interfaces/IStrategyRepository.js";
import { IDrawsProvider } from "../../domain/interfaces/IDrawsProvider.js";
import { StrategyContext, StrategyDefinition } from "../../domain/models/Strategy.js";

export class StrategyUseCase {
  private strategies: Map<string, StrategyDefinition> = new Map();

  constructor(
    private strategyRepo: IStrategyRepository,
    private lotteryScraper: IDrawsProvider
  ) {}

  registerStrategy(strategy: StrategyDefinition) {
    this.strategies.set(strategy.id, strategy);
  }

  getStrategy(id: string): StrategyDefinition | undefined {
    return this.strategies.get(id);
  }

  getAllRegisteredStrategies(): StrategyDefinition[] {
    return Array.from(this.strategies.values());
  }

  async executeStrategy(id: string, context: StrategyContext): Promise<string> {
    const strategy = this.strategies.get(id);
    if (!strategy) {
      throw new Error(`Strategy ${id} not found`);
    }

    const map = context.mapSource === 'p3' 
      ? await this.lotteryScraper.getP3Map()
      : await this.lotteryScraper.getP4Map();
      
    let result = await strategy.run(context, map);

    const targetStrategies = [
      "max_per_week_day", "freq_analysis", "gap_due", "calendar_pattern",
      "transition_follow", "trend_momentum", "positional_analysis",
      "consensus_multi", "est_individuales", "markov_order2",
      "decade_family", "mirror_complement", "terminal_analysis",
      "cycle_detector", "streak_analysis", "bayesian_score",
      "unodostres", "unodostres_plus"
    ];

    if (targetStrategies.includes(id) && strategy.getCandidates) {
      try {
        const candidates = await strategy.getCandidates(context, map);
        if (candidates && candidates.length > 0) {
          const formatted = candidates.map(c => String(c).padStart(2, "0")).join(", ");
          result += `\n\n🎯 *Candidatos tipo:* ${formatted}`;
        }
      } catch (e) {
        console.error(`Error appending candidates for strategy ${id}:`, e);
      }
    }

    return result;
  }

  async getCandidates(id: string, context: StrategyContext): Promise<number[]> {
    const strategy = this.strategies.get(id);
    if (!strategy) {
      throw new Error(`Strategy ${id} not found`);
    }

    if (!strategy.getCandidates) {
      return [];
    }

    const map = context.mapSource === 'p3' 
      ? await this.lotteryScraper.getP3Map()
      : await this.lotteryScraper.getP4Map();
      
    return await strategy.getCandidates(context, map);
  }
}
