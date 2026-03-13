import { GoogleSpreadsheet } from "google-spreadsheet";
import { IUserRepository } from "../../domain/interfaces/IUserRepository.js";
import { User, PlanRequest } from "../../domain/models/User.js";
import { getSheetId, getSheetAuth } from "./GoogleSheetConfig.js";

const SHEET_HEADERS = ["userId", "nombre", "telefono", "menus", "menus_labels", "plan", "plan_status", "pending_plan", "plan_temporality", "plan_expiry", "trial_used"] as const;

export class GoogleSheetUserRepository implements IUserRepository {
  private allowed: number[] = [];
  private menus: Record<string, string[]> = {};
  private users: Record<string, User> = {};
  private requestedPlans: Record<string, PlanRequest> = {};
  private lastReloadAt: number = 0;
  private readonly CACHE_TTL_MS = 3 * 60 * 1000;
  
  // To resolve labels to names in the sheet just for display purposes
  private labelResolver: ((id: string) => string | undefined) | null = null;
  
  setLabelResolver(resolver: (id: string) => string | undefined) {
    this.labelResolver = resolver;
  }

  private async loadIfNeeded(): Promise<void> {
    if (Date.now() - this.lastReloadAt < this.CACHE_TTL_MS) return;
    await this.forceLoad();
  }

  async forceLoad(): Promise<void> {
    const sheetId = getSheetId();
    const auth = getSheetAuth();
    if (!sheetId || !auth) return;
    
    try {
      const doc = new GoogleSpreadsheet(sheetId, auth);
      await doc.loadInfo();
      const sheet = doc.sheetsByIndex[0];
      if (!sheet) return;
      try {
        await sheet.loadHeaderRow(1);
      } catch {
        await sheet.setHeaderRow([...SHEET_HEADERS], 1);
        return;
      }
      
      const rows = await sheet.getRows({ offset: 0, limit: 10000 });
      const headers = sheet.headerValues;
      
      this.allowed = [];
      this.menus = {};
      this.users = {};
      this.requestedPlans = {};
      
      for (const row of rows) {
        const obj = row.toObject() as Record<string, unknown>;
        const values = headers.map((h) => (h ? String(obj[h] ?? "").trim() : ""));
        const uidStr = values[0] ?? "";
        const uid = parseInt(uidStr, 10);
        if (uidStr === "" || Number.isNaN(uid)) continue;
        
        const planStatus = (values[6] ?? "").toLowerCase();
        if (planStatus === "requested") {
          this.requestedPlans[uidStr] = {
            userId: uid,
            requestedPlan: values[5] || "—",
            username: values[1] || undefined,
            phone: values[2] || undefined,
            temporality: values[8] || undefined,
            paymentMethod: "unknown",
            timestamp: Date.now(),
            status: "pending"
          };
          continue;
        }
        
        this.allowed.push(uid);
        let menuIds: string[] = [];
        const menusStr = values[3];
        if (menusStr) {
          menuIds = menusStr.split(",").map(s => s.trim()).filter(Boolean);
        } else {
          // Legacy support
          const g = String(obj.est_grupos ?? "").trim();
          const i = String(obj.est_individuales ?? "").trim();
          if (g === "1" || g.toLowerCase() === "true") menuIds.push("est_grupos");
          if (i === "1" || i.toLowerCase() === "true") menuIds.push("est_individuales");
        }
        this.menus[uidStr] = menuIds;
        this.users[uidStr] = {
          id: uid,
          username: values[1] || undefined,
          phone: values[2] || undefined,
          role: "user", // Admin logic handled externally or via another layer
          planId: values[5] || undefined,
          assignedMenuIds: menuIds
        };
      }
      this.lastReloadAt = Date.now();
    } catch (e) {
      console.error("[GoogleSheetUserRepository] Error loading:", e);
    }
  }

  private async persist(): Promise<void> {
    const sheetId = getSheetId();
    const auth = getSheetAuth();
    if (!sheetId || !auth) return;
    
    try {
      const doc = new GoogleSpreadsheet(sheetId, auth);
      await doc.loadInfo();
      const sheet = doc.sheetsByIndex[0];
      if (!sheet) return;
      await sheet.setHeaderRow([...SHEET_HEADERS], 1);
      await sheet.clearRows();
      
      const allowedRows = this.allowed.map(uid => {
        const key = String(uid);
        const menuIds = this.menus[key] || [];
        const user = this.users[key];
        const labels = menuIds.map((id) => this.labelResolver?.(id) ?? id);
        return {
          userId: key,
          nombre: user?.username ?? "",
          telefono: user?.phone ?? "",
          menus: menuIds.join(","),
          menus_labels: labels.join(", "),
          plan: user?.planId ?? "",
          plan_status: "approved",
          pending_plan: "",
          plan_temporality: "",
          plan_expiry: "",
          trial_used: ""
        };
      });
      
      const requestedRows = Object.values(this.requestedPlans).map(req => ({
        userId: String(req.userId),
        nombre: req.username ?? "",
        telefono: "", // req.phone ?? "",
        menus: "",
        menus_labels: "",
        plan: req.requestedPlan,
        plan_status: "requested",
        pending_plan: "",
        plan_temporality: "", // req.temporality ?? "",
        plan_expiry: "",
        trial_used: ""
      }));
      
      const rows = [...allowedRows, ...requestedRows];
      if (rows.length > 0) {
        await sheet.addRows(rows as any);
      }
    } catch (e) {
      console.error("[GoogleSheetUserRepository] Error saving:", e);
    }
  }

  async getUser(userId: number): Promise<User | null> {
    await this.loadIfNeeded();
    return this.users[String(userId)] || null;
  }

  async getAllUsers(): Promise<User[]> {
    await this.loadIfNeeded();
    return Object.values(this.users);
  }

  async saveUser(user: User): Promise<void> {
    await this.loadIfNeeded();
    this.users[String(user.id)] = user;
    if (!this.allowed.includes(user.id)) {
      this.allowed.push(user.id);
    }
    this.menus[String(user.id)] = user.assignedMenuIds;
    await this.persist();
  }

  async getUserMenus(userId: number): Promise<string[]> {
    await this.loadIfNeeded();
    return this.menus[String(userId)] || [];
  }

  async setUserMenus(userId: number, menuIds: string[]): Promise<void> {
    await this.loadIfNeeded();
    this.menus[String(userId)] = menuIds;
    if (this.users[String(userId)]) {
      this.users[String(userId)].assignedMenuIds = menuIds;
    }
    await this.persist();
  }

  async addMenuToUser(userId: number, menuId: string): Promise<void> {
    const menus = await this.getUserMenus(userId);
    if (!menus.includes(menuId)) {
      await this.setUserMenus(userId, [...menus, menuId]);
    }
  }

  async removeMenuFromUser(userId: number, menuId: string): Promise<void> {
    const menus = await this.getUserMenus(userId);
    await this.setUserMenus(userId, menus.filter(m => m !== menuId));
  }

  async isAllowed(userId: number): Promise<boolean> {
    await this.loadIfNeeded();
    return this.allowed.includes(userId);
  }

  async addAllowed(userId: number): Promise<void> {
    await this.loadIfNeeded();
    if (!this.allowed.includes(userId)) {
      this.allowed.push(userId);
      this.users[String(userId)] = { id: userId, role: "user", assignedMenuIds: [] };
      await this.persist();
    }
  }

  async removeAllowed(userId: number): Promise<void> {
    await this.loadIfNeeded();
    this.allowed = this.allowed.filter(id => id !== userId);
    delete this.users[String(userId)];
    delete this.menus[String(userId)];
    await this.persist();
  }

  async addPlanRequest(request: PlanRequest): Promise<void> {
    await this.loadIfNeeded();
    this.requestedPlans[String(request.userId)] = request;
    await this.persist();
  }

  async getPlanRequests(): Promise<PlanRequest[]> {
    await this.loadIfNeeded();
    return Object.values(this.requestedPlans);
  }

  async removePlanRequest(userId: number): Promise<void> {
    await this.loadIfNeeded();
    delete this.requestedPlans[String(userId)];
    await this.persist();
  }
}
