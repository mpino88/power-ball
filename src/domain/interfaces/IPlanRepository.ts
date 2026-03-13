import { Plan } from '../models/Plan.js';

export interface IPlanRepository {
  getPlans(): Promise<Plan[]>;
  getPlanById(id: string): Promise<Plan | null>;
  getPlanByTitle(title: string): Promise<Plan | null>;
  savePlans(plans: Plan[]): Promise<void>;
}
