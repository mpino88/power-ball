/**
 * Teclados del módulo Seguridad: panel principal, gestionar menús, menús por usuario.
 */

import { InlineKeyboard } from "grammy";
import type { getExtraMenuIds as GetExtraMenuIds, getExtraMenuLabel as GetExtraMenuLabel } from "../menu-registry.js";
import type { getUsername as GetUsername, getPhone as GetPhone } from "../user-config.js";
import type { getPlanById as GetPlanById } from "../plans.js";

export function buildSecurityKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👥 Listar usuarios", "admin_list")
    .row()
    .text("➕ Agregar acceso", "admin_add")
    .text("➖ Quitar acceso", "admin_remove")
    .row()
    .text("📋 Asignar estrategias a usuarios", "admin_menus")
    .row()
    .text("⚙️ Gestionar Estrategias", "admin_estrategias_manage")
    .row()
    .text("💰 Gestionar planes", "admin_plans_manage")
    .row()
    .text("◀️ Volver al menú principal", "security_main");
}

export function buildManagePlansKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📋 Listar planes", "admin_plans_list")
    .row()
    .text("📋 Menús por plan", "admin_plans_menus")
    .row()
    .text("📩 Solicitudes pendientes", "admin_plans_requests")
    .row()
    .text("👤 Asignar plan a usuario", "admin_plans_assign_user")
    .row()
    .text("➕ Añadir plan", "admin_plans_add")
    .text("✏️ Editar plan", "admin_plans_edit")
    .row()
    .text("🗑 Eliminar plan", "admin_plans_delete")
    .row()
    .text("◀️ Volver a Seguridad", "security_open");
}

/** Teclado para asociar/desasociar menús a un plan. ➕ = añadir al plan, ➖ = quitar del plan. */
export function buildPlanMenusKeyboard(
  planId: string,
  getExtraMenuIds: typeof GetExtraMenuIds,
  getExtraMenuLabel: typeof GetExtraMenuLabel,
  getPlanById: typeof GetPlanById
): InlineKeyboard {
  const plan = getPlanById(planId);
  const planMenuIds = new Set(plan?.menuIds ?? []);
  const kb = new InlineKeyboard();
  for (const menuId of getExtraMenuIds()) {
    const label = getExtraMenuLabel(menuId) ?? menuId;
    const isInPlan = planMenuIds.has(menuId);
    kb
      .text(isInPlan ? "➖" : "➕", `admin_plan_menu_${isInPlan ? "remove" : "add"}_${planId}|${menuId}`)
      .text(label, `admin_plan_menu_${isInPlan ? "remove" : "add"}_${planId}|${menuId}`)
      .row();
  }
  kb.text("◀️ Volver a Gestionar planes", "admin_plans_manage");
  return kb;
}

/** Teclado Gestionar Estrategias (dueño): listar, crear, eliminar, asignar, solicitudes. */
export function buildManageEstrategiasKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📋 Listar estrategias", "admin_estrategias_list")
    .row()
    .text("➕ Crear estrategia", "admin_estrategias_create")
    .text("🗑 Eliminar estrategia", "admin_estrategias_delete")
    .row()
    .text("📋 Asignar estrategias a usuarios", "admin_menus")
    .text("📥 Solicitudes pendientes", "admin_estrategias_requests")
    .row()
    .text("🌐 Visibilidad (pública/privada)", "admin_estrategias_visibility")
    .row()
    .text("◀️ Volver a Seguridad", "security_open");
}

/** Teclado Gestionar Estrategias (usuario): listar, crear, eliminar (sin asignar). */
export function buildManageEstrategiasKeyboardUser(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📋 Listar estrategias", "estrategias_list")
    .row()
    .text("➕ Crear estrategia", "estrategias_create")
    .text("🗑 Eliminar estrategia", "estrategias_delete")
    .row()
    .text("◀️ Volver", "volver");
}

export function buildUserMenusKeyboard(
  uid: number,
  getExtraMenuIds: typeof GetExtraMenuIds,
  getExtraMenuLabel: typeof GetExtraMenuLabel
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const menuId of getExtraMenuIds()) {
    kb
      .text("➕", `admin_menu_add_${uid}|${menuId}`)
      .text("➖", `admin_menu_remove_${uid}|${menuId}`)
      .row();
  }
  kb.text("◀️ Volver a Seguridad", "security_open");
  return kb;
}

/** Una línea de texto con ID, nombre y teléfono del usuario (para listas en Seguridad). */
export function formatUserLine(
  uid: number,
  getUsername: typeof GetUsername,
  getPhone: typeof GetPhone
): string {
  const name = getUsername(uid) || "—";
  const phone = getPhone(uid);
  return `• \`${uid}\` — ${name} — ${phone ? "📞 " + phone : "—"}`;
}
