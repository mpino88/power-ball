import { User, PlanRequest } from '../models/User.js';

export interface IUserRepository {
  getUser(userId: number): Promise<User | null>;
  getAllUsers(): Promise<User[]>;
  saveUser(user: User): Promise<void>;
  
  // Menus
  getUserMenus(userId: number): Promise<string[]>;
  setUserMenus(userId: number, menuIds: string[]): Promise<void>;
  addMenuToUser(userId: number, menuId: string): Promise<void>;
  removeMenuFromUser(userId: number, menuId: string): Promise<void>;

  // Allowlist
  isAllowed(userId: number): Promise<boolean>;
  addAllowed(userId: number): Promise<void>;
  removeAllowed(userId: number): Promise<void>;

  // Plan Requests
  addPlanRequest(request: PlanRequest): Promise<void>;
  getPlanRequests(): Promise<PlanRequest[]>;
  removePlanRequest(userId: number): Promise<void>;
}
