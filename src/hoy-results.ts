import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

const HOY_FILE = path.join(process.cwd(), "data", "hoy-results.json");

/** Resultado del sorteo guardado por push manual del admin. Persiste hasta el próximo push. */
export interface HoyResult {
  // Valores del sorteo (raw string: "123" o "4567")
  p3_m?: string;
  p3_e?: string;
  p4_m?: string;
  p4_e?: string;
  // Fecha EST (MM/DD/YY) del push para cada slot
  p3_m_date?: string;
  p3_e_date?: string;
  p4_m_date?: string;
  p4_e_date?: string;
  /** ISO timestamp del último push (cualquier slot) */
  updatedAt?: string;
}

/** Devuelve la fecha EST actual en formato MM/DD/YY */
export function getTodayEST(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "2-digit",
    day: "2-digit",
    year: "2-digit",
  });
}

export function getHoyResult(): HoyResult {
  try {
    if (!existsSync(HOY_FILE)) return {};
    return JSON.parse(readFileSync(HOY_FILE, "utf-8")) as HoyResult;
  } catch (e) {
    return {};
  }
}

export function saveHoyResult(data: Partial<HoyResult>) {
  try {
    const current = getHoyResult();
    const today = getTodayEST();

    // Inyectar la fecha del día de este push para cada slot que se esté actualizando
    const dateFields: Partial<HoyResult> = {};
    if (data.p3_m !== undefined) dateFields.p3_m_date = today;
    if (data.p3_e !== undefined) dateFields.p3_e_date = today;
    if (data.p4_m !== undefined) dateFields.p4_m_date = today;
    if (data.p4_e !== undefined) dateFields.p4_e_date = today;

    const updated: HoyResult = {
      ...current,
      ...data,
      ...dateFields,
      updatedAt: new Date().toISOString(),
    };
    const dataDir = path.dirname(HOY_FILE);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    writeFileSync(HOY_FILE, JSON.stringify(updated, null, 2));
  } catch (e) {
    console.error(`❌ [APEX] Error guardando hoy-results.json:`, e);
  }
}

