export interface CustomStrategy {
  id: string;
  titulo: string;
  descripcion?: string;
  createdBy?: number;
  price?: string;
  visibility?: "public" | "private";
  subscribers?: number;
}

export interface IStrategyRepository {
  getCustomStrategies(): Promise<CustomStrategy[]>;
  saveCustomStrategies(strategies: CustomStrategy[]): Promise<void>;
}
