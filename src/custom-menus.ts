/**
 * Menús extra creados por el dueño (CRUD). Se persisten en data/extra-menus.json.
 * Los integrados (est_grupos, est_individuales) se registran en bot y no están aquí.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE_PATH = path.join(DATA_DIR, "extra-menus.json");

export interface CustomMenu {
  id: string;
  /** Título del menú (texto del botón). */
  label: string;
  /** Descripción del menú/estrategia. */
  description?: string;
  /** Por defecto "pendiente"; "implemented" cuando tiene funcionalidad asignada. */
  status?: "pendiente" | "implemented";
}

let customMenus: CustomMenu[] = [];

function load(): CustomMenu[] {
  try {
    if (existsSync(FILE_PATH)) {
      const raw = readFileSync(FILE_PATH, "utf8");
      const data = JSON.parse(raw) as { menus?: CustomMenu[] };
      const list = Array.isArray(data.menus) ? data.menus : [];
      return list.filter(
      (m) => m && typeof m.id === "string" && typeof m.label === "string"
    ) as CustomMenu[];
    }
  } catch (e) {
    console.error("[custom-menus] Error al cargar:", e);
  }
  return [];
}

function save(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE_PATH, JSON.stringify({ menus: customMenus }, null, 2), "utf8");
  } catch (e) {
    console.error("[custom-menus] Error al guardar:", e);
  }
}

export function initCustomMenus(): CustomMenu[] {
  customMenus = load();
  return [...customMenus];
}

export function getCustomMenus(): CustomMenu[] {
  return [...customMenus];
}

export function isCustomMenu(id: string): boolean {
  return customMenus.some((m) => m.id === id);
}

export function addCustomMenu(id: string, label: string, description?: string): boolean {
  const normId = id.trim().replace(/\s+/g, "_");
  if (!normId) return false;
  if (customMenus.some((m) => m.id === normId)) return false;
  customMenus.push({
    id: normId,
    label: label.trim() || normId,
    description: description?.trim() || undefined,
    status: "pendiente",
  });
  save();
  return true;
}

export function updateCustomMenu(
  id: string,
  updates: { label?: string; description?: string; status?: "pendiente" | "implemented" }
): boolean {
  const entry = customMenus.find((m) => m.id === id);
  if (!entry) return false;
  if (updates.label !== undefined) entry.label = updates.label.trim() || entry.label;
  if (updates.description !== undefined) entry.description = updates.description.trim() || undefined;
  if (updates.status !== undefined) entry.status = updates.status;
  save();
  return true;
}

export function removeCustomMenu(id: string): boolean {
  const before = customMenus.length;
  customMenus = customMenus.filter((m) => m.id !== id);
  if (customMenus.length < before) {
    save();
    return true;
  }
  return false;
}
