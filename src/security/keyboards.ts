/**
 * Teclados del módulo Seguridad: panel principal, gestionar menús, menús por usuario.
 */

import { InlineKeyboard } from "grammy";
import type { getExtraMenuIds as GetExtraMenuIds, getExtraMenuLabel as GetExtraMenuLabel } from "../menu-registry.js";
import type { getUsername as GetUsername, getPhone as GetPhone } from "../user-config.js";

export function buildSecurityKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👥 Listar usuarios con acceso", "admin_list")
    .row()
    .text("➕ Agregar acceso", "admin_add")
    .text("➖ Quitar acceso", "admin_remove")
    .row()
    .text("📋 Menús por usuario", "admin_menus")
    .row()
    .text("⚙️ Gestionar menús", "admin_menus_manage")
    .row()
    .text("◀️ Volver al menú principal", "security_main");
}

export function buildManageMenusKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📋 Asignar menús a usuarios", "admin_menus")
    .row()
    .text("📋 Listar menús", "admin_menus_list")
    .row()
    .text("➕ Crear menú", "admin_menus_create")
    .text("✏️ Editar menú", "admin_menus_edit")
    .row()
    .text("🗑 Eliminar menú", "admin_menus_delete")
    .row()
    .text("◀️ Volver a Seguridad", "security_open");
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
