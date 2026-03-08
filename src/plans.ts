/**
 * Planes que ve el usuario sin acceso (Básico, Pro, etc.). CRUD por el dueño.
 * Persistencia: data/plans.json.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

const DATA_DIR = path.join(process.cwd(), "data");
const FILE_PATH = path.join(DATA_DIR, "plans.json");

/** Opciones de temporalidad disponibles. */
export const TEMPORALITIES = [
  { id: "1d", label: "1 Día" },
  { id: "1m", label: "1 Mes" },
  { id: "3m", label: "3 Meses" },
  { id: "6m", label: "6 Meses" },
  { id: "9m", label: "9 Meses" },
  { id: "1a", label: "1 Año" },
] as const;

/** Temporalidades visibles para planes regulares (excluye 1d). */
export const REGULAR_TEMPORALITIES = TEMPORALITIES.filter((t) => t.id !== "1d");
/** Temporalidades visibles para planes de prueba / auto-aprobados (solo 1d). */
export const TRIAL_TEMPORALITIES = TEMPORALITIES.filter((t) => t.id === "1d");

export type Temporality = (typeof TEMPORALITIES)[number]["id"];

/** Calcula la fecha de caducidad a partir de una fecha base y una temporalidad. */
export function computeExpiryDate(from: Date, temporality: Temporality | string): Date {
  const d = new Date(from);
  switch (temporality) {
    case "1d": d.setDate(d.getDate() + 1); break;
    case "1m": d.setMonth(d.getMonth() + 1); break;
    case "3m": d.setMonth(d.getMonth() + 3); break;
    case "6m": d.setMonth(d.getMonth() + 6); break;
    case "9m": d.setMonth(d.getMonth() + 9); break;
    case "1a": d.setFullYear(d.getFullYear() + 1); break;
  }
  return d;
}

/** Formatea fecha como MM/DD/YY. */
export function formatDateMMDDYY(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}

export interface Plan {
  id: string;
  title: string;
  description: string;
  price: string;
  /** IDs de menús que se asignan al usuario cuando se aprueba este plan. */
  menuIds?: string[];
  /** Precios por temporalidad (columnas F-I del Sheet de Planes). */
  price_1m?: string;
  price_3m?: string;
  price_6m?: string;
  price_9m?: string;
  price_1a?: string;
  /** Si true, el plan se aprueba automáticamente sin intervención del admin. */
  autoApprove?: boolean;
}

/** Devuelve el precio de un plan según la temporalidad; si no está definido usa price. */
export function getPriceForTemporality(plan: Plan, temporality: string): string {
  switch (temporality) {
    case "1m": return plan.price_1m || plan.price || "";
    case "3m": return plan.price_3m || plan.price || "";
    case "6m": return plan.price_6m || plan.price || "";
    case "9m": return plan.price_9m || plan.price || "";
    case "1a": return plan.price_1a || plan.price || "";
    default: return plan.price || "";
  }
}

let plans: Plan[] = [];

/** Tipo de fila de Plan para el Sheet (incluye campos de temporalidad). */
export interface PlanSheetRow {
  id: string;
  title: string;
  description: string;
  price: string;
  menuIds: string;
  price_1m: string;
  price_3m: string;
  price_6m: string;
  price_9m: string;
  price_1a: string;
  autoApprove: string;
}

/** Cuando está definido, save() persiste en la 3ª pestaña del Sheet en lugar del archivo JSON. */
let planSheetPersist: ((items: PlanSheetRow[]) => Promise<void>) | null = null;

export function setPlanSheetPersist(
  fn: ((items: PlanSheetRow[]) => Promise<void>) | null
): void {
  planSheetPersist = fn;
}

/** Inicializa desde filas de la hoja (3ª pestaña). */
export function initPlansFromSheet(rows: PlanSheetRow[]): void {
  plans = rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description ?? "",
    price: r.price ?? "",
    menuIds: r.menuIds
      ? r.menuIds.split(",").map((m) => m.trim()).filter((m) => m.length > 0)
      : [],
    price_1m: r.price_1m ?? "",
    price_3m: r.price_3m ?? "",
    price_6m: r.price_6m ?? "",
    price_9m: r.price_9m ?? "",
    price_1a: r.price_1a ?? "",
    autoApprove: r.autoApprove === "true",
  }));
}

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
  if (planSheetPersist) {
    const items: PlanSheetRow[] = plans.map((p) => ({
      id: p.id,
      title: p.title,
      description: p.description ?? "",
      price: p.price ?? "",
      menuIds: Array.isArray(p.menuIds) ? p.menuIds.join(",") : "",
      price_1m: p.price_1m ?? "",
      price_3m: p.price_3m ?? "",
      price_6m: p.price_6m ?? "",
      price_9m: p.price_9m ?? "",
      price_1a: p.price_1a ?? "",
      autoApprove: p.autoApprove ? "true" : "",
    }));
    void planSheetPersist(items);
    return;
  }
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

/** Planes por defecto si no existe data/plans.json o está vacío. */
const DEFAULT_PLANS: Plan[] = [
  {
    id: "basico",
    title: "Básico",
    description:
      "Consultas por período: Fijo (P3), Corrido (P4) — Hoy, Ayer, Semana o fecha elegida. Incluye Estadísticas por grupo (Mediodía y Noche).",
    price: "",
    menuIds: ["est_grupos"],
  },
  {
    id: "pro",
    title: "Pro",
    description:
      "Todo lo de Básico (consultas Fijo/Corrido + Estadísticas por grupo) más Estadísticas individuales: Top 10 más hot por Mediodía/Noche.",
    price: "",
    menuIds: ["est_grupos", "est_individuales"],
  },
  {
    id: "trial",
    title: "Trial",
    description:
      "Acceso de prueba gratuito por 1 día. Incluye consultas Fijo/Corrido y Estadísticas por grupo. Sin necesidad de aprobación — actívalo al instante.",
    price: "",
    menuIds: ["est_grupos"],
    autoApprove: true,
  },
];

export function initPlans(): Plan[] {
  plans = load();
  if (plans.length === 0) {
    plans = DEFAULT_PLANS.map((p) => ({ ...p, menuIds: p.menuIds ? [...p.menuIds] : [] }));
    save();
    console.log("[plans] Creados planes por defecto: Básico, Pro.");
  }
  return [...plans];
}

export function getPlans(): Plan[] {
  return [...plans];
}

export function getPlanById(id: string): Plan | undefined {
  return plans.find((p) => p.id === id);
}

/** Busca un plan por título. */
export function getPlanByTitle(title: string): Plan | undefined {
  const t = title.trim();
  return plans.find((p) => p.title.trim() === t);
}

export function addPlan(
  id: string,
  title: string,
  description: string,
  price: string,
  menuIds?: string[],
  pricing?: { price_1m?: string; price_3m?: string; price_6m?: string; price_9m?: string; price_1a?: string },
  autoApprove?: boolean
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
    price_1m: pricing?.price_1m ?? "",
    price_3m: pricing?.price_3m ?? "",
    price_6m: pricing?.price_6m ?? "",
    price_9m: pricing?.price_9m ?? "",
    price_1a: pricing?.price_1a ?? "",
    autoApprove: autoApprove ?? false,
  });
  save();
  return true;
}

export function updatePlan(
  id: string,
  updates: {
    title?: string;
    description?: string;
    price?: string;
    menuIds?: string[];
    price_1m?: string;
    price_3m?: string;
    price_6m?: string;
    price_9m?: string;
    price_1a?: string;
    autoApprove?: boolean;
  }
): boolean {
  const plan = plans.find((p) => p.id === id);
  if (!plan) return false;
  if (updates.title !== undefined) plan.title = updates.title.trim() || plan.title;
  if (updates.description !== undefined) plan.description = updates.description.trim();
  if (updates.price !== undefined) plan.price = updates.price.trim();
  if (updates.menuIds !== undefined) plan.menuIds = Array.isArray(updates.menuIds) ? updates.menuIds.filter((m) => typeof m === "string") : [];
  if (updates.price_1m !== undefined) plan.price_1m = updates.price_1m.trim();
  if (updates.price_3m !== undefined) plan.price_3m = updates.price_3m.trim();
  if (updates.price_6m !== undefined) plan.price_6m = updates.price_6m.trim();
  if (updates.price_9m !== undefined) plan.price_9m = updates.price_9m.trim();
  if (updates.price_1a !== undefined) plan.price_1a = updates.price_1a.trim();
  if (updates.autoApprove !== undefined) plan.autoApprove = updates.autoApprove;
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
