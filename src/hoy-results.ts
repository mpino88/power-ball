import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { DateDrawsMap } from "./domain/models/Strategy.js";

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

// ─── Cross-period Blind Spot: merge hoy-results into strategy maps ───────────
//
// PROBLEM:
//   Strategies using params.ambos=true (or any cross-period analysis) need BOTH
//   today's midday and evening in the map. The in-memory PDF cache (getP3Map) uses
//   LEUT (Last Expected Update Time) to decide when to refresh, but there is a race:
//
//   Example — 9:45 PM (evening draw just happened):
//     • PDF cache was last loaded at 2:15 PM (after midday) → LEUT = 8:20 PM → STALE
//     • auto-draw webhook fires → forceInvalidateCache() + fresh PDF fetch → OK for tonight
//     • BUT: between 8:20 PM and when the webhook fires (~9:52 PM), any strategy execution
//       would trigger a PDF refresh that gets the PDF BEFORE tonight's draw is posted,
//       missing tonight's result. The strategy sees: midday ✅ | evening from yesterday 🕰️
//
//   Additionally, if the bot was restarted mid-day, the cache is cold and midday might
//   not be in the PDF yet when the cache was first warmed (before 2:05 PM).
//
// SOLUTION:
//   Before passing a map to any strategy, inject whatever is in hoy-results.json for
//   TODAY. This ensures the manually/auto-pushed result is always the primary source
//   of truth for the current day, closing the gap between PDF update and bot restart.
//
//   Notes:
//   • Only injects entries with a date matching `today` — no stale data contamination.
//   • Does NOT overwrite existing map entries if hoy-results has no value for that slot
//     (empty string means "no result" and is intentionally skipped).
//   • Never applies during testing mode (caller passes `cutoff !== null`); the cutoff
//     already represents a historical simulation date.

/**
 * Returns a copy of `map` augmented with today's P3 results from hoy-results.json.
 * Safe to call even when hoy-results is empty or outdated (no-op in those cases).
 */
export function mergeHoyIntoP3Map(map: DateDrawsMap, hoy: HoyResult, today: string): DateDrawsMap {
  const mVal = hoy.p3_m_date === today && hoy.p3_m && hoy.p3_m.length >= 3 ? hoy.p3_m : null;
  const eVal = hoy.p3_e_date === today && hoy.p3_e && hoy.p3_e.length >= 3 ? hoy.p3_e : null;
  if (!mVal && !eVal) return map;

  const todayEntry = { ...(map[today] ?? {}) };
  if (mVal) todayEntry.m = mVal.split("").map(Number);
  if (eVal) todayEntry.e = eVal.split("").map(Number);
  return { ...map, [today]: todayEntry };
}

/**
 * Returns a copy of `map` augmented with today's P4 results from hoy-results.json.
 * Safe to call even when hoy-results is empty or outdated (no-op in those cases).
 */
export function mergeHoyIntoP4Map(map: DateDrawsMap, hoy: HoyResult, today: string): DateDrawsMap {
  const mVal = hoy.p4_m_date === today && hoy.p4_m && hoy.p4_m.length >= 4 ? hoy.p4_m : null;
  const eVal = hoy.p4_e_date === today && hoy.p4_e && hoy.p4_e.length >= 4 ? hoy.p4_e : null;
  if (!mVal && !eVal) return map;

  const todayEntry = { ...(map[today] ?? {}) };
  if (mVal) todayEntry.m = mVal.split("").map(Number);
  if (eVal) todayEntry.e = eVal.split("").map(Number);
  return { ...map, [today]: todayEntry };
}

