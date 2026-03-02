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
  /** Título (texto del botón). */
  label: string;
  /** Descripción: qué hace la estrategia. */
  description?: string;
  /** Por defecto "pendiente"; "implemented" cuando tiene funcionalidad asignada. */
  status?: "pendiente" | "implemented";
  /** undefined o 0 = creada por dueño; número = userId del usuario que la creó (se auto-asigna). */
  createdBy?: number;
}

let customMenus: CustomMenu[] = [];

/** Cuando está definido, save() persiste en la 2ª pestaña del Sheet en lugar del archivo JSON. */
let strategySheetPersist: ((items: CustomMenu[]) => Promise<void>) | null = null;

export function setStrategySheetPersist(fn: ((items: CustomMenu[]) => Promise<void>) | null): void {
  strategySheetPersist = fn;
}

/** Inicializa desde filas de la hoja (id, titulo, descripcion, createdBy). No guarda en archivo. */
export function initCustomMenusFromSheet(rows: { id: string; titulo: string; descripcion?: string; createdBy?: number }[]): void {
  customMenus = rows.map((r) => ({
    id: r.id,
    label: r.titulo,
    description: r.descripcion?.trim() || undefined,
    status: "pendiente" as const,
    createdBy: r.createdBy === 0 ? undefined : r.createdBy,
  }));
}

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
  if (strategySheetPersist) {
    void strategySheetPersist([...customMenus]);
    return;
  }
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

export function addCustomMenu(
  id: string,
  label: string,
  description?: string,
  createdBy?: number
): boolean {
  const normId = id.trim().replace(/\s+/g, "_");
  if (!normId) return false;
  if (customMenus.some((m) => m.id === normId)) return false;
  customMenus.push({
    id: normId,
    label: label.trim() || normId,
    description: description?.trim() || undefined,
    status: "pendiente",
    createdBy: createdBy === 0 ? undefined : createdBy,
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
/** userId del creador de la estrategia, o undefined si la creó el dueño (o no es custom). */
export function getMenuCreatedBy(menuId: string): number | undefined {
  const m = customMenus.find((x) => x.id === menuId);
  return m?.createdBy;
}

/** Estrategias creadas por este usuario (para listar/eliminar propias). */
export function getCustomMenusCreatedBy(userId: number): CustomMenu[] {
  return customMenus.filter((m) => m.createdBy === userId);
}
/** true si la estrategia la creó este usuario (puede eliminarla). */
export function canDeleteCustomMenu(menuId: string, userId: number, isOwner: boolean): boolean {
  if (isOwner) return true;
  const m = customMenus.find((x) => x.id === menuId);
  return m?.createdBy === userId;
}
