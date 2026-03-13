import { IUserRepository } from "../../domain/interfaces/IUserRepository.js";
import { IPlanRepository } from "../../domain/interfaces/IPlanRepository.js";
import { User, PlanRequest } from "../../domain/models/User.js";
import { Plan } from "../../domain/models/Plan.js";

export class UserManagementUseCase {
  constructor(
    private userRepository: IUserRepository,
    private planRepository: IPlanRepository
  ) {}

  async getUser(userId: number): Promise<User | null> {
    return this.userRepository.getUser(userId);
  }

  async applyPlan(userId: number, planId: string): Promise<boolean> {
    const user = await this.userRepository.getUser(userId);
    const plan = await this.planRepository.getPlanById(planId);
    if (!plan) return false;
    
    if (user) {
      user.planId = planId;
      await this.userRepository.saveUser(user);
    } else {
      await this.userRepository.saveUser({
        id: userId,
        role: "user",
        planId: planId,
        assignedMenuIds: []
      });
    }
    return true;
  }

  async isAllowed(userId: number, ownerIds: number[]): Promise<boolean> {
    if (ownerIds.includes(userId)) return true;
    return this.userRepository.isAllowed(userId);
  }

  async getAssignedMenus(userId: number): Promise<string[]> {
    return this.userRepository.getUserMenus(userId);
  }

  async getCombinedMenus(userId: number, ownerIds: number[]): Promise<string[]> {
    const user = await this.getUser(userId);
    const menus = new Set<string>();
    
    // Add explicitly assigned menus
    const assigned = await this.getAssignedMenus(userId);
    assigned.forEach(m => menus.add(m));

    // Add plan menus
    if (user?.planId) {
      const plan = await this.planRepository.getPlanByTitle(user.planId);
      if (plan && plan.menuIds) {
        plan.menuIds.split(',').forEach(m => {
          if (m.trim()) menus.add(m.trim());
        });
      }
    }

    // Admins might get all menus ideally, but we stick to the old logic for now
    return Array.from(menus);
  }
}
