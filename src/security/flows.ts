/**
 * Flujos conversacionales de Seguridad: agregar usuario (ID → Nombre → Teléfono),
 * crear menú (solo texto del botón; el id se genera automáticamente), editar menú, eliminar menú.
 */

export type AddingStep =
  | { step: 1; userId?: number }
  | { step: 2; userId: number; name?: string }
  | { step: 3; userId: number; name: string; phone?: string };

/** Un solo paso: esperando el texto del botón (el id se deriva en messageHandler). */
export type CreatingStep = { step: 1 };

export const addingUserFlow = new Map<number, AddingStep>();
export const creatingMenuFlow = new Map<number, CreatingStep>();
export const editingMenuFlow = new Map<number, { menuId: string }>();
export const deletingMenuFlow = new Map<number, { menuId: string }>();

export function clearAllFlows(userId: number): void {
  addingUserFlow.delete(userId);
  creatingMenuFlow.delete(userId);
  editingMenuFlow.delete(userId);
  deletingMenuFlow.delete(userId);
}
