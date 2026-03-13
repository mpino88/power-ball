import { GoogleSpreadsheet } from "google-spreadsheet";
import { IPlanRepository } from "../../domain/interfaces/IPlanRepository.js";
import { Plan } from "../../domain/models/Plan.js";
import { getSheetId, getSheetAuth } from "./GoogleSheetConfig.js";

const PLANS_SHEET_TITLE = "Planes";
const PLANS_HEADERS = ["id", "title", "description", "price", "menuIds", "price_1m", "price_3m", "price_6m", "price_9m", "price_1a", "autoApprove"] as const;

export class GoogleSheetPlanRepository implements IPlanRepository {
  async getPlans(): Promise<Plan[]> {
    const sheetId = getSheetId();
    const auth = getSheetAuth();
    if (!sheetId || !auth) return [];
    try {
      const doc = new GoogleSpreadsheet(sheetId, auth);
      await doc.loadInfo();
      let sheet = doc.sheetsByIndex[2];
      if (!sheet) {
        await doc.addSheet({ title: PLANS_SHEET_TITLE, headerValues: [...PLANS_HEADERS] });
        return [];
      }
      try {
        await sheet.loadHeaderRow(1);
      } catch {
        await sheet.setHeaderRow([...PLANS_HEADERS], 1);
        return [];
      }
      const rows = await sheet.getRows({ offset: 0, limit: 500 });
      const headers = sheet.headerValues;
      const result: Plan[] = [];
      const seenIds = new Set<string>();
      for (const row of rows) {
        const obj = row.toObject() as Record<string, unknown>;
        const values = headers.map((h) => (h ? String(obj[h] ?? "").trim() : ""));
        const id = values[0] ?? "";
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        result.push({
          id,
          title: values[1] || id,
          description: values[2] ?? "",
          price: values[3] ?? "",
          menuIds: values[4] ?? "",
          price_1m: values[5] ?? "",
          price_3m: values[6] ?? "",
          price_6m: values[7] ?? "",
          price_9m: values[8] ?? "",
          price_1a: values[9] ?? "",
          autoApprove: values[10] === "true",
        });
      }
      return result;
    } catch (e) {
      console.error("[GoogleSheetPlanRepository] Error loading plans:", e);
      return [];
    }
  }

  async getPlanById(id: string): Promise<Plan | null> {
    const plans = await this.getPlans();
    return plans.find(p => p.id === id) || null;
  }

  async getPlanByTitle(title: string): Promise<Plan | null> {
    const plans = await this.getPlans();
    return plans.find(p => p.title.toLowerCase() === title.toLowerCase()) || null;
  }

  async savePlans(plans: Plan[]): Promise<void> {
    const sheetId = getSheetId();
    const auth = getSheetAuth();
    if (!sheetId || !auth) return;
    try {
      const doc = new GoogleSpreadsheet(sheetId, auth);
      await doc.loadInfo();
      let sheet = doc.sheetsByIndex[2];
      if (!sheet) {
        sheet = await doc.addSheet({ title: PLANS_SHEET_TITLE, headerValues: [...PLANS_HEADERS] });
      }
      await sheet.setHeaderRow([...PLANS_HEADERS], 1);
      await sheet.clearRows();
      if (plans.length > 0) {
        const rows = plans.map(r => ({
          ...r,
          autoApprove: r.autoApprove ? "true" : ""
        }));
        await sheet.addRows(rows as any);
      }
    } catch (e) {
      console.error("[GoogleSheetPlanRepository] Error saving plans:", e);
    }
  }
}
