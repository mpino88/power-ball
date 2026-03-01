/**
 * Registro de menús extra (asignables por usuario).
 *
 * - Menús default (Fijo, Corrido, Ambos, Ayuda): siempre visibles para usuarios autorizados; no se registran aquí.
 * - Menús del dueño (Seguridad): solo dueño; no se registran aquí.
 * - Menús extra: se registran aquí; el dueño puede asignarlos a cada usuario en Seguridad → Menús por usuario.
 *
 * Cómo agregar una funcionalidad nueva:
 * 1. En bot.ts, en registerExtraMenus(), llamar:
 *    registerExtraMenu("mi_menu_id", "📌 Mi menú", async (ctx) => { ... });
 * 2. El callback que recibe el usuario será "menu_mi_menu_id".
 * 3. Asignar el menú a usuarios en Seguridad → Menús por usuario (➕/➖).
 */

import type { Context } from "grammy";

export type ExtraMenuHandler = (ctx: Context) => Promise<void>;

interface ExtraMenuEntry {
  label: string;
  handler: ExtraMenuHandler;
}

const registry = new Map<string, ExtraMenuEntry>();

/**
 * Registra un menú extra. Llamar al arranque del bot (p. ej. desde bot.ts).
 * El callback que verá el usuario será "menu_<id>".
 */
export function registerExtraMenu(id: string, label: string, handler: ExtraMenuHandler): void {
  registry.set(id, { label, handler });
}

export function unregisterExtraMenu(id: string): boolean {
  return registry.delete(id);
}

export function updateExtraMenuLabel(id: string, label: string): void {
  const entry = registry.get(id);
  if (entry) entry.label = label;
}

export function getExtraMenuIds(): string[] {
  return Array.from(registry.keys());
}

export function getExtraMenuLabel(id: string): string | undefined {
  return registry.get(id)?.label;
}

export function getHandler(id: string): ExtraMenuHandler | undefined {
  return registry.get(id)?.handler;
}

/** Prefijo para callbacks de menús extra (ej: menu_est_grupos). */
export const EXTRA_MENU_CALLBACK_PREFIX = "menu_";
