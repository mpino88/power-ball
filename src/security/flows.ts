/**
 * Flujos conversacionales de Seguridad: agregar usuario, crear/editar menú, crear/editar plan.
 */

export type AddingStep =
  | { step: 1; userId?: number }
  | { step: 2; userId: number; name?: string }
  | { step: 3; userId: number; name: string; phone?: string };

/** Crear estrategia: paso 1 = título; paso 2 = descripción. createdBy = userId si la crea un usuario (se auto-asigna). */
export type CreatingStep =
  | { step: 1; createdBy?: number }
  | { step: 2; label: string; createdBy?: number };

/** Crear plan: título → descripción → precio → menús. */
export type CreatingPlanStep =
  | { step: 1 }
  | { step: 2; title: string }
  | { step: 3; title: string; description: string }
  | { step: 4; title: string; description: string; price: string };

/** Editar plan: planId + título → descripción → precio → menús. */
export type EditingPlanStep =
  | { step: 1; planId: string }
  | { step: 2; planId: string; title: string }
  | { step: 3; planId: string; title: string; description: string }
  | { step: 4; planId: string; title: string; description: string; price: string };

/** Asignar plan a usuario (dueño): paso 1 = esperando ID, paso 2 = esperando elegir plan (por callback). */
export type AssigningPlanStep = { step: 1 } | { step: 2; targetUserId: number };

export const addingUserFlow = new Map<number, AddingStep>();
export const creatingMenuFlow = new Map<number, CreatingStep>();
export const editingMenuFlow = new Map<number, { menuId: string }>();
export const deletingMenuFlow = new Map<number, { menuId: string }>();
export const creatingPlanFlow = new Map<number, CreatingPlanStep>();
export const editingPlanFlow = new Map<number, EditingPlanStep>();
export const deletingPlanFlow = new Map<number, { planId: string }>();
export const assigningPlanFlow = new Map<number, AssigningPlanStep>();

export function clearAllFlows(userId: number): void {
  addingUserFlow.delete(userId);
  creatingMenuFlow.delete(userId);
  editingMenuFlow.delete(userId);
  deletingMenuFlow.delete(userId);
  creatingPlanFlow.delete(userId);
  editingPlanFlow.delete(userId);
  deletingPlanFlow.delete(userId);
  assigningPlanFlow.delete(userId);
}
