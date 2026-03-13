import { GoogleSpreadsheet } from "google-spreadsheet";
import { IStrategyRepository, CustomStrategy } from "../../domain/interfaces/IStrategyRepository.js";
import { getSheetId, getSheetAuth } from "./GoogleSheetConfig.js";

const STRATEGIES_SHEET_TITLE = "Estrategias";
const STRATEGIES_HEADERS = ["id", "titulo", "descripcion", "createdBy", "price", "status", "subscribers"] as const;

export class GoogleSheetStrategyRepository implements IStrategyRepository {
  async getCustomStrategies(): Promise<CustomStrategy[]> {
    const sheetId = getSheetId();
    const auth = getSheetAuth();
    if (!sheetId || !auth) return [];
    try {
      const doc = new GoogleSpreadsheet(sheetId, auth);
      await doc.loadInfo();
      let sheet = doc.sheetsByIndex[1];
      if (!sheet) {
        await doc.addSheet({ title: STRATEGIES_SHEET_TITLE, headerValues: [...STRATEGIES_HEADERS] });
        return [];
      }
      try {
        await sheet.loadHeaderRow(1);
      } catch {
        await sheet.setHeaderRow([...STRATEGIES_HEADERS], 1);
        return [];
      }
      const rows = await sheet.getRows({ offset: 0, limit: 5000 });
      let headers = sheet.headerValues;
      const result: CustomStrategy[] = [];
      for (const row of rows) {
        const obj = row.toObject() as Record<string, unknown>;
        const values = headers.map((h) => (h ? String(obj[h] ?? "").trim() : ""));
        const id = values[0] ?? "";
        if (!id) continue;
        const createdByStr = values[3] ?? "";
        const createdBy = createdByStr ? parseInt(createdByStr, 10) : undefined;
        result.push({
          id,
          titulo: values[1] || id,
          descripcion: values[2] || undefined,
          createdBy: Number.isNaN(createdBy as number) ? undefined : (createdBy as number),
          price: values[4]?.trim() || undefined,
          visibility: (values[5]?.trim() === "public" ? "public" : "private"),
          subscribers: parseInt(values[6] ?? "0", 10) || 0,
        });
      }
      return result;
    } catch (e) {
      console.error("[GoogleSheetStrategyRepository] Error loading strategies:", e);
      return [];
    }
  }

  async saveCustomStrategies(strategies: CustomStrategy[]): Promise<void> {
    const sheetId = getSheetId();
    const auth = getSheetAuth();
    if (!sheetId || !auth) return;
    try {
      const doc = new GoogleSpreadsheet(sheetId, auth);
      await doc.loadInfo();
      let sheet = doc.sheetsByIndex[1];
      if (!sheet) {
        sheet = await doc.addSheet({ title: STRATEGIES_SHEET_TITLE, headerValues: [...STRATEGIES_HEADERS] });
      }
      await sheet.setHeaderRow([...STRATEGIES_HEADERS], 1);
      await sheet.clearRows();
      if (strategies.length > 0) {
        const rows = strategies.map(r => ({
          id: r.id,
          titulo: r.titulo,
          descripcion: r.descripcion ?? "",
          createdBy: r.createdBy ? String(r.createdBy) : "",
          price: r.price ?? "",
          status: r.visibility ?? "private",
          subscribers: String(r.subscribers ?? 0),
        }));
        await sheet.addRows(rows);
      }
    } catch (e) {
      console.error("[GoogleSheetStrategyRepository] Error saving strategies:", e);
    }
  }
}
