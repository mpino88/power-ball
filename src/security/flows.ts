/**
 * Flujos conversacionales de Seguridad: agregar usuario, crear/editar menú, crear/editar plan.
 */

export type AddingStep =
  | { step: 1; userId?: number }
  | { step: 2; userId: number; name?: string }
  | { step: 3; userId: number; name: string; phone?: string };

/** Crear estrategia: paso 1 = título; paso 2 = descripción; paso 3 = precio.
 * createdBy = userId del creador (siempre presente; se usa para auto-asignar al completar).
 * fromAdmin = true cuando el flujo lo inicia el panel de admin (cambia el teclado post-creación). */
export type CreatingStep =
  | { step: 1; createdBy?: number; fromAdmin?: boolean }
  | { step: 2; label: string; createdBy?: number; fromAdmin?: boolean }
  | { step: 3; label: string; description?: string; createdBy?: number; fromAdmin?: boolean };

/** Crear plan: título → descripción → menuIds → price_1m → price_3m → price_6m → price_9m → price_1a. */
export type CreatingPlanStep =
  | { step: 1 }
  | { step: 2; title: string }
  | { step: 3; title: string; description: string }
  | { step: 4; title: string; description: string; menuIds: string[] }
  | { step: 5; title: string; description: string; menuIds: string[]; price_1m: string }
  | { step: 6; title: string; description: string; menuIds: string[]; price_1m: string; price_3m: string }
  | { step: 7; title: string; description: string; menuIds: string[]; price_1m: string; price_3m: string; price_6m: string }
  | { step: 8; title: string; description: string; menuIds: string[]; price_1m: string; price_3m: string; price_6m: string; price_9m: string };

/** Editar plan: planId + título → descripción → menuIds → price_1m → price_3m → price_6m → price_9m → price_1a. */
export type EditingPlanStep =
  | { step: 1; planId: string }
  | { step: 2; planId: string; title: string }
  | { step: 3; planId: string; title: string; description: string }
  | { step: 4; planId: string; title: string; description: string; menuIds: string[] }
  | { step: 5; planId: string; title: string; description: string; menuIds: string[]; price_1m: string }
  | { step: 6; planId: string; title: string; description: string; menuIds: string[]; price_1m: string; price_3m: string }
  | { step: 7; planId: string; title: string; description: string; menuIds: string[]; price_1m: string; price_3m: string; price_6m: string }
  | { step: 8; planId: string; title: string; description: string; menuIds: string[]; price_1m: string; price_3m: string; price_6m: string; price_9m: string };

/** Asignar plan a usuario (dueño): paso 1 = esperando ID, paso 2 = esperando elegir plan, paso 3 = esperando elegir temporalidad. */
export type AssigningPlanStep =
  | { step: 1 }
  | { step: 2; targetUserId: number }
  | { step: 3; targetUserId: number; planId: string };

export type UpdatingHoyStep = {
  step: "selecting_period" | "input_p3" | "input_p4";
  period?: "m" | "e";
  p3?: string;
};

export const addingUserFlow = new Map<number, AddingStep>();
export const creatingMenuFlow = new Map<number, CreatingStep>();
export const editingMenuFlow = new Map<number, { menuId: string }>();
export const deletingMenuFlow = new Map<number, { menuId: string }>();
export const creatingPlanFlow = new Map<number, CreatingPlanStep>();
export const editingPlanFlow = new Map<number, EditingPlanStep>();
export const deletingPlanFlow = new Map<number, { planId: string }>();
export const assigningPlanFlow = new Map<number, AssigningPlanStep>();

/** Tipos para el flujo de Formas de Pago. */
export type CreatingPaymentMethodStep =
  | { step: 1 }
  | { step: 2; description: string }
  | { step: 3; description: string; account: string };

export type EditingPaymentMethodStep =
  | { step: 1; id: string }
  | { step: 2; id: string; description: string }
  | { step: 3; id: string; description: string; account: string };

export const creatingPaymentMethodFlow = new Map<number, CreatingPaymentMethodStep>();
export const editingPaymentMethodFlow = new Map<number, EditingPaymentMethodStep>();
export const updatingHoyFlow = new Map<number, UpdatingHoyStep>();
export const generatingCacheFlow = new Map<number, { step: 1 }>();
export const broadcastingFlow = new Map<number, { step: 1 }>();

export function clearAllFlows(userId: number): void {
  addingUserFlow.delete(userId);
  creatingMenuFlow.delete(userId);
  editingMenuFlow.delete(userId);
  deletingMenuFlow.delete(userId);
  creatingPlanFlow.delete(userId);
  editingPlanFlow.delete(userId);
  deletingPlanFlow.delete(userId);
  assigningPlanFlow.delete(userId);
  creatingPaymentMethodFlow.delete(userId);
  editingPaymentMethodFlow.delete(userId);
  updatingHoyFlow.delete(userId);
  generatingCacheFlow.delete(userId);
  broadcastingFlow.delete(userId);
}
