/**
 * Menús extra creados por el dueño (CRUD). Se persisten en data/extra-menus.json.
 * Los integrados (est_grupos, est_individuales) se registran en bot y no están aquí.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE_PATH = path.join(DATA_DIR, "extra-menus.json");

export type StrategyVisibility = "public" | "private";

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
  /** Precio (mostrado solo si el usuario tiene acceso vía menus, no vía plan). */
  price?: string;
  /** "private" = solo creador y dueño; "public" = visible en Tienda. Siempre "private" al crear. */
  visibility?: StrategyVisibility;
  /** Nº de usuarios (distinto al creador) que tienen la estrategia asignada explícitamente. Persistido en Sheet. */
  subscribers?: number;
}

let customMenus: CustomMenu[] = [];

/** Cuando está definido, save() persiste en la 2ª pestaña del Sheet en lugar del archivo JSON. */
let strategySheetPersist: ((items: CustomMenu[]) => Promise<void>) | null = null;

export function setStrategySheetPersist(fn: ((items: CustomMenu[]) => Promise<void>) | null): void {
  strategySheetPersist = fn;
}

/** Inicializa desde filas de la hoja (id, titulo, descripcion, createdBy, price, visibility, subscribers). No guarda en archivo. */
export function initCustomMenusFromSheet(rows: {
  id: string;
  titulo: string;
  descripcion?: string;
  createdBy?: number;
  price?: string;
  visibility?: string;
  subscribers?: number;
}[]): void {
  customMenus = rows.map((r) => ({
    id: r.id,
    label: r.titulo,
    description: r.descripcion?.trim() || undefined,
    status: "pendiente" as const,
    createdBy: r.createdBy === 0 ? undefined : r.createdBy,
    price: r.price?.trim() || undefined,
    visibility: (r.visibility?.toLowerCase() === "public" ? "public" : "private") as StrategyVisibility,
    subscribers: r.subscribers ?? 0,
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
  createdBy?: number,
  price?: string,
  visibility?: StrategyVisibility
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
    price: price?.trim() || undefined,
    visibility: visibility === "public" ? "public" : "private",
    subscribers: 0,
  });
  save();
  return true;
}

export function updateCustomMenu(
  id: string,
  updates: {
    label?: string;
    description?: string;
    status?: "pendiente" | "implemented";
    price?: string;
    visibility?: StrategyVisibility;
  }
): boolean {
  const entry = customMenus.find((m) => m.id === id);
  if (!entry) return false;
  if (updates.label !== undefined) entry.label = updates.label.trim() || entry.label;
  if (updates.description !== undefined) entry.description = updates.description.trim() || undefined;
  if (updates.status !== undefined) entry.status = updates.status;
  if (updates.price !== undefined) entry.price = updates.price.trim() || undefined;
  if (updates.visibility !== undefined) entry.visibility = updates.visibility === "public" ? "public" : "private";
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

export function getMenuPrice(menuId: string): string | undefined {
  return customMenus.find((m) => m.id === menuId)?.price;
}

export function getMenuVisibility(menuId: string): StrategyVisibility {
  const v = customMenus.find((m) => m.id === menuId)?.visibility;
  return v === "public" ? "public" : "private";
}

/** Estrategias públicas (visibles en Tienda para cualquier usuario). */
export function getPublicStrategies(): CustomMenu[] {
  return customMenus.filter((m) => m.visibility === "public");
}

/** true si el usuario puede cambiar la visibilidad (creador o dueño). */
export function canChangeVisibility(menuId: string, userId: number, isOwner: boolean): boolean {
  if (isOwner) return true;
  const m = customMenus.find((x) => x.id === menuId);
  return m?.createdBy === userId;
}

/** Incrementa o decrementa el contador de suscriptores de una estrategia y persiste. Mínimo 0. */
export function adjustSubscriberCount(menuId: string, delta: number): void {
  const m = customMenus.find((x) => x.id === menuId);
  if (!m) return;
  m.subscribers = Math.max(0, (m.subscribers ?? 0) + delta);
  save();
}

/** Devuelve el contador de suscriptores de una estrategia custom (0 si no existe o no es custom). */
export function getMenuSubscribers(menuId: string): number {
  return customMenus.find((m) => m.id === menuId)?.subscribers ?? 0;
}

/**
 * Inserta en bloque los ítems que aún no existen (por id), con createdBy=undefined (dueño).
 * Llama a save() una sola vez al final. Retorna el número de ítems nuevos añadidos.
 * Útil para sembrar estrategias built-in al arrancar el bot sin N escrituras al Sheet.
 */
export function seedCustomMenus(
  items: Array<{
    id: string;
    label: string;
    description?: string;
    visibility?: StrategyVisibility;
  }>
): number {
  let added = 0;
  for (const item of items) {
    const normId = item.id.trim();
    if (!normId || customMenus.some((m) => m.id === normId)) continue;
    customMenus.push({
      id: normId,
      label: item.label.trim() || normId,
      description: item.description?.trim() || undefined,
      status: "pendiente",
      createdBy: undefined,
      price: undefined,
      visibility: item.visibility ?? "private",
      subscribers: 0,
    });
    added++;
  }
  if (added > 0) save();
  return added;
}
