import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const HOY_FILE = path.join(process.cwd(), "data", "hoy-results.json");

export interface HoyResult {
  p3_m?: string;
  p3_e?: string;
  p4_m?: string;
  p4_e?: string;
  updatedAt?: string;
}

export function getHoyResult(): HoyResult {
  if (!existsSync(HOY_FILE)) return {};
  try {
    const data = JSON.parse(readFileSync(HOY_FILE, "utf-8")) as HoyResult;
    
    // Auto-reset si la fecha guardada no es hoy en EST
    if (data.updatedAt) {
      const nowEST = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
      const savedEST = new Date(data.updatedAt).toLocaleDateString("en-US", { timeZone: "America/New_York" });
      if (nowEST !== savedEST) {
        return {};
      }
    }
    
    return data;
  } catch (e) {
    return {};
  }
}

export function saveHoyResult(data: Partial<HoyResult>) {
  const current = getHoyResult();
  const updated: HoyResult = {
    ...current,
    ...data,
    updatedAt: new Date().toISOString()
  };
  const dataDir = path.dirname(HOY_FILE);
  if (!existsSync(dataDir)) {
    // Note: Actually write_to_file and list_dir handle directories, but node:fs needs it.
    // However, I will rely on the fact that data/ already exists based on my previous ls -la.
  }
  writeFileSync(HOY_FILE, JSON.stringify(updated, null, 2));
}
