import { IStrategyRepository } from "../../domain/interfaces/IStrategyRepository.js";
import { ILotteryScraper } from "../../domain/interfaces/ILotteryScraper.js";
import { StrategyContext, StrategyDefinition } from "../../domain/models/Strategy.js";

export class StrategyUseCase {
  private strategies: Map<string, StrategyDefinition> = new Map();

  constructor(
    private strategyRepo: IStrategyRepository,
    private lotteryScraper: ILotteryScraper
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
      
    return await strategy.run(context, map);
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
