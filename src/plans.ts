/**
 * Planes que ve el usuario sin acceso (Básico, Pro, etc.). CRUD por el dueño.
 * Persistencia: data/plans.json.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE_PATH = path.join(DATA_DIR, "plans.json");

export interface Plan {
  id: string;
  title: string;
  description: string;
  price: string;
  /** IDs de menús que se asignan al usuario cuando se aprueba este plan (ej: est_grupos, est_individuales). */
  menuIds?: string[];
}

let plans: Plan[] = [];

function load(): Plan[] {
  try {
    if (existsSync(FILE_PATH)) {
      const raw = readFileSync(FILE_PATH, "utf8");
      const data = JSON.parse(raw) as { plans?: Plan[] };
      const list = Array.isArray(data.plans) ? data.plans : [];
      return list
        .filter(
          (p) =>
            p &&
            typeof p.id === "string" &&
            typeof p.title === "string" &&
            typeof p.description === "string" &&
            typeof p.price === "string"
        )
        .map((p) => ({
          ...p,
          menuIds: Array.isArray(p.menuIds) ? p.menuIds.filter((m) => typeof m === "string") : [],
        }));
    }
  } catch (e) {
    console.error("[plans] Error al cargar:", e);
  }
  return [];
}

function save(): void {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE_PATH, JSON.stringify({ plans }, null, 2), "utf8");
  } catch (e) {
    console.error("[plans] Error al guardar:", e);
  }
}

/** Convierte título a id (slug). */
export function titleToPlanId(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "") || "plan";
}

export function initPlans(): Plan[] {
  plans = load();
  return [...plans];
}

export function getPlans(): Plan[] {
  return [...plans];
}

export function getPlanById(id: string): Plan | undefined {
  return plans.find((p) => p.id === id);
}

/** Busca un plan por título (p. ej. para asignar menús al aprobar una solicitud). */
export function getPlanByTitle(title: string): Plan | undefined {
  const t = title.trim();
  return plans.find((p) => p.title.trim() === t);
}

export function addPlan(
  id: string,
  title: string,
  description: string,
  price: string,
  menuIds?: string[]
): boolean {
  const normId = id.trim() || titleToPlanId(title);
  if (plans.some((p) => p.id === normId)) return false;
  const ids = Array.isArray(menuIds) ? menuIds.filter((m) => typeof m === "string") : [];
  plans.push({
    id: normId,
    title: title.trim() || normId,
    description: description.trim() || "",
    price: price.trim() || "",
    menuIds: ids,
  });
  save();
  return true;
}

export function updatePlan(
  id: string,
  updates: { title?: string; description?: string; price?: string; menuIds?: string[] }
): boolean {
  const plan = plans.find((p) => p.id === id);
  if (!plan) return false;
  if (updates.title !== undefined) plan.title = updates.title.trim() || plan.title;
  if (updates.description !== undefined) plan.description = updates.description.trim();
  if (updates.price !== undefined) plan.price = updates.price.trim();
  if (updates.menuIds !== undefined) plan.menuIds = Array.isArray(updates.menuIds) ? updates.menuIds.filter((m) => typeof m === "string") : [];
  save();
  return true;
}

export function removePlan(id: string): boolean {
  const before = plans.length;
  plans = plans.filter((p) => p.id !== id);
  if (plans.length < before) {
    save();
    return true;
  }
  return false;
}
