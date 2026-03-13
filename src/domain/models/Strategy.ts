export type DateDrawsMap = Record<string, { m?: number[]; e?: number[] }>;

export type StrategyMapSource = "p3" | "p4";

export type StrategyPeriod = "m" | "e";

export interface StrategyContext {
  mapSource: StrategyMapSource;
  period: StrategyPeriod;
  params?: Record<string, unknown>;
}

export interface StrategyResult {
  message: string;
  candidates?: number[];
}

export interface StrategyDefinition {
  readonly id: string;
  readonly description?: string;
  
  getContextMessage(menuLabel: string): string;
  
  // Note: UI specific building (like InlineKeyboard) should be handled in Presentation
  // run() executes the math and returns message (and optional candidates)
  run(context: StrategyContext, map: DateDrawsMap): Promise<string>;
  getCandidates?(context: StrategyContext, map: DateDrawsMap): Promise<number[]>;
}
