/**
 * Handlers de callbacks de Seguridad: security_open, security_main, admin_*.
 * Retorna { result, keyboard } si el callback fue manejado; null en caso contrario.
 */

import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import {
  getAllowedUsers,
  getUsername,
  getPhone,
  addAllowed,
  removeAllowed,
  setUserInfo,
  toggleExtraMenu,
  getExtraMenus,
  removeMenuFromAllUsers,
} from "../user-config.js";
import {
  getExtraMenuIds,
  getExtraMenuLabel,
  unregisterExtraMenu,
  updateExtraMenuLabel,
} from "../menu-registry.js";
import {
  getCustomMenus,
  isCustomMenu,
  addCustomMenu,
  updateCustomMenu,
  removeCustomMenu,
} from "../custom-menus.js";
import {
  buildSecurityKeyboard,
  buildManageMenusKeyboard,
  buildUserMenusKeyboard,
  formatUserLine,
} from "./keyboards.js";
import { addingUserFlow, creatingMenuFlow, editingMenuFlow, deletingMenuFlow, clearAllFlows } from "./flows.js";

const BUILTIN_MENU_IDS = new Set(["est_grupos", "est_individuales"]);

export interface SecurityCallbackDeps {
  buildMainKeyboard: (userId: number | undefined) => InlineKeyboard;
}

export async function handleSecurityCallback(
  ctx: Context,
  data: string,
  deps: SecurityCallbackDeps
): Promise<{ result: string; keyboard: InlineKeyboard } | null> {
  if (ctx.from?.id === undefined) return null;
  const isAdmin =
    data === "security_open" ||
    data === "security_main" ||
    data.startsWith("admin_");

  if (!isAdmin) return null;

  await ctx.answerCallbackQuery();

  let result: string;
  let keyboard: InlineKeyboard;

  if (data === "security_open") {
    result = "🔒 *Seguridad* — Gestiona quién puede usar el bot y sus menús.";
    keyboard = buildSecurityKeyboard();
  } else if (data === "security_main") {
    clearAllFlows(ctx.from.id);
    result = "👋 Elige juego y luego el período:";
    keyboard = deps.buildMainKeyboard(ctx.from.id);
  } else if (data === "admin_list") {
    const list = getAllowedUsers();
    const lines = list.map((id) => {
      const name = getUsername(id);
      const phone = getPhone(id);
      const extra = [name && `— ${name}`, phone && `📞 ${phone}`].filter(Boolean).join(" ");
      return extra ? `• \`${id}\` ${extra}` : `• \`${id}\``;
    });
    result =
      "👥 *Usuarios con acceso* (" + list.length + ")\n\n" +
      (lines.length ? lines.join("\n") : "_Ninguno_");
    keyboard = new InlineKeyboard().text("◀️ Volver a Seguridad", "security_open");
  } else if (data === "admin_add") {
    addingUserFlow.set(ctx.from.id, { step: 1 });
    result =
      "➕ *Agregar acceso* (paso 1/3)\n\nEnvía el *ID* del usuario (número). El usuario puede ver su ID escribiendo /start sin acceso.\n\n/cancel para cancelar.";
    keyboard = new InlineKeyboard().text("◀️ Cancelar", "security_open");
  } else if (data === "admin_remove") {
    const list = getAllowedUsers();
    const slice = list.slice(0, 30);
    result =
      list.length === 0
        ? "➖ *Quitar acceso*\n\n_No hay usuarios con acceso_ (solo tú como dueño)."
        : "➖ *Quitar acceso*\n\nToca ❌ para quitar el acceso a ese usuario.\n\n" +
          slice.map((uid) => formatUserLine(uid, getUsername, getPhone)).join("\n");
    keyboard = new InlineKeyboard();
    for (const uid of slice) {
      const label = getUsername(uid) ? `❌ ${getUsername(uid)}` : `❌ ${uid}`;
      keyboard.text(label, `admin_revoke_${uid}`).row();
    }
    keyboard.text("◀️ Volver a Seguridad", "security_open");
  } else if (data.startsWith("admin_revoke_")) {
    const uid = parseInt(data.replace("admin_revoke_", ""), 10);
    if (Number.isNaN(uid)) {
      result = "Error.";
      keyboard = buildSecurityKeyboard();
    } else {
      await removeAllowed(uid);
      const list = getAllowedUsers();
      const slice = list.slice(0, 30);
      result =
        list.length === 0
          ? `✅ Usuario \`${uid}\` sin acceso. Ya no quedan otros usuarios en la lista.`
          : `✅ Usuario \`${uid}\` sin acceso. Toca ❌ para quitar a otro:\n\n` +
            slice.map((uid) => formatUserLine(uid, getUsername, getPhone)).join("\n");
      keyboard = new InlineKeyboard();
      for (const id of slice) {
        const label = getUsername(id) ? `❌ ${getUsername(id)}` : `❌ ${id}`;
        keyboard.text(label, `admin_revoke_${id}`).row();
      }
      keyboard.text("◀️ Volver a Seguridad", "security_open");
    }
  } else if (data === "admin_menus") {
    const list = getAllowedUsers();
    const slice = list.slice(0, 20);
    result =
      "📋 *Menús por usuario*\n\nElige un usuario para asignar menús extra:\n\n" +
      slice.map((uid) => formatUserLine(uid, getUsername, getPhone)).join("\n");
    keyboard = new InlineKeyboard();
    for (const uid of slice) {
      const label = getUsername(uid) ? `${getUsername(uid)} (${uid})` : `Usuario ${uid}`;
      keyboard.text(label.length > 64 ? `Usuario ${uid}` : label, `admin_menus_${uid}`).row();
    }
    keyboard.text("◀️ Volver a Seguridad", "security_open");
  } else if (/^admin_menus_\d+$/.test(data)) {
    const uid = parseInt(data.replace("admin_menus_", ""), 10);
    keyboard = buildUserMenusKeyboard(uid, getExtraMenuIds, getExtraMenuLabel);
    const extra = getExtraMenus(uid);
    const ids = getExtraMenuIds();
    const menuList = ids
      .map((id) => `• ${getExtraMenuLabel(id) ?? id}${extra.includes(id) ? " ✓" : ""}`)
      .join("\n");
    result = `📋 *Menús para usuario* \`${uid}\`\n\nCada fila: ➕ dar acceso, ➖ quitar acceso.\n\n${menuList}`;
  } else if (data.startsWith("admin_menu_add_")) {
    const rest = data.replace("admin_menu_add_", "");
    const [uidStr, menuId] = rest.includes("|")
      ? rest.split("|")
      : [rest.split("_")[0], rest.split("_").slice(1).join("_")];
    const uid = parseInt(uidStr!, 10);
    const validIds = getExtraMenuIds();
    if (Number.isNaN(uid) || !validIds.includes(menuId)) {
      result = "Error.";
      keyboard = buildSecurityKeyboard();
    } else {
      const extra = getExtraMenus(uid);
      if (!extra.includes(menuId)) await toggleExtraMenu(uid, menuId);
      keyboard = buildUserMenusKeyboard(uid, getExtraMenuIds, getExtraMenuLabel);
      const extraAfter = getExtraMenus(uid);
      const menuList = validIds
        .map((id) => `• ${getExtraMenuLabel(id) ?? id}${extraAfter.includes(id) ? " ✓" : ""}`)
        .join("\n");
      result = `📋 *Menús para usuario* \`${uid}\`\n\n✅ Acceso dado: ${getExtraMenuLabel(menuId) ?? menuId}\n\n${menuList}`;
    }
  } else if (data.startsWith("admin_menu_remove_")) {
    const rest = data.replace("admin_menu_remove_", "");
    const [uidStr, menuId] = rest.includes("|")
      ? rest.split("|")
      : [rest.split("_")[0], rest.split("_").slice(1).join("_")];
    const uid = parseInt(uidStr!, 10);
    const validIds = getExtraMenuIds();
    if (Number.isNaN(uid) || !validIds.includes(menuId)) {
      result = "Error.";
      keyboard = buildSecurityKeyboard();
    } else {
      const extra = getExtraMenus(uid);
      if (extra.includes(menuId)) await toggleExtraMenu(uid, menuId);
      keyboard = buildUserMenusKeyboard(uid, getExtraMenuIds, getExtraMenuLabel);
      const extraAfter = getExtraMenus(uid);
      const menuList = validIds
        .map((id) => `• ${getExtraMenuLabel(id) ?? id}${extraAfter.includes(id) ? " ✓" : ""}`)
        .join("\n");
      result = `📋 *Menús para usuario* \`${uid}\`\n\n❌ Acceso quitado: ${getExtraMenuLabel(menuId) ?? menuId}\n\n${menuList}`;
    }
  } else if (data === "admin_back") {
    clearAllFlows(ctx.from.id);
    result = "🔒 *Seguridad* — Gestiona quién puede usar el bot y sus menús.";
    keyboard = buildSecurityKeyboard();
  } else if (data === "admin_menus_manage") {
    result =
      "⚙️ *Gestionar menús*\n\nLista, crea, edita o elimina menús extra (los que luego asignas a usuarios).";
    keyboard = buildManageMenusKeyboard();
  } else if (data === "admin_menus_list") {
    const ids = getExtraMenuIds();
    const builtIn = ids.filter((id) => BUILTIN_MENU_IDS.has(id));
    const custom = ids.filter((id) => isCustomMenu(id));
    const lines = [
      ...builtIn.map((id) => `• ${getExtraMenuLabel(id) ?? id} (\`${id}\`) — _integrado_`),
      ...custom.map((id) => `• ${getExtraMenuLabel(id) ?? id} (\`${id}\`)`),
    ];
    result = "📋 *Menús extra*\n\n" + (lines.length ? lines.join("\n") : "_Ninguno_");
    keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar menús", "admin_menus_manage");
  } else if (data === "admin_menus_create") {
    creatingMenuFlow.set(ctx.from.id, { step: 1 });
    result =
      "➕ *Crear menú*\n\nEnvía solo el *texto del botón* (ej: 📅 Fechas Calor).\n\n" +
      "El _id_ se generará automáticamente (minúsculas, snake_case, sin acentos) y se usará después para asignar la funcionalidad del botón.\n\n/cancel para cancelar.";
    keyboard = new InlineKeyboard().text("◀️ Cancelar", "admin_menus_manage");
  } else if (data === "admin_menus_edit") {
    const custom = getCustomMenus();
    if (custom.length === 0) {
      result =
        "✏️ *Editar menú*\n\n_No hay menús creados por ti._ Solo se pueden editar los que hayas creado desde aquí.";
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar menús", "admin_menus_manage");
    } else {
      result = "✏️ *Editar menú*\n\nElige el menú a editar:";
      keyboard = new InlineKeyboard();
      for (const m of custom) {
        keyboard.text(`✏️ ${m.label}`, `admin_menus_edit_pick_${m.id}`).row();
      }
      keyboard.text("◀️ Volver a Gestionar menús", "admin_menus_manage");
    }
  } else if (data.startsWith("admin_menus_edit_pick_")) {
    const menuId = data.replace("admin_menus_edit_pick_", "");
    if (!isCustomMenu(menuId)) {
      result = "Error: menú no encontrado.";
      keyboard = buildManageMenusKeyboard();
    } else {
      editingMenuFlow.set(ctx.from.id, { menuId });
      const label = getExtraMenuLabel(menuId) ?? menuId;
      result = `✏️ *Editar menú* \`${menuId}\`\n\nEnvía el *nuevo texto* del botón (ahora: ${label}).\n\n/cancel para cancelar.`;
      keyboard = new InlineKeyboard().text("◀️ Cancelar", "admin_menus_manage");
    }
  } else if (data === "admin_menus_delete") {
    const custom = getCustomMenus();
    if (custom.length === 0) {
      result =
        "🗑 *Eliminar menú*\n\n_No hay menús creados por ti._ Solo se pueden eliminar los que hayas creado desde aquí.";
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar menús", "admin_menus_manage");
    } else {
      result =
        "🗑 *Eliminar menú*\n\nElige el menú a eliminar (se quitará de todos los usuarios):";
      keyboard = new InlineKeyboard();
      for (const m of custom) {
        keyboard.text(`🗑 ${m.label}`, `admin_menus_delete_pick_${m.id}`).row();
      }
      keyboard.text("◀️ Volver a Gestionar menús", "admin_menus_manage");
    }
  } else if (data.startsWith("admin_menus_delete_pick_")) {
    const menuId = data.replace("admin_menus_delete_pick_", "");
    if (!isCustomMenu(menuId)) {
      result = "Error: menú no encontrado.";
      keyboard = buildManageMenusKeyboard();
    } else {
      deletingMenuFlow.set(ctx.from.id, { menuId });
      const label = getExtraMenuLabel(menuId) ?? menuId;
      result = `🗑 ¿Eliminar el menú *${label}* (\`${menuId}\`)?\n\nSe quitará de todos los usuarios que lo tengan asignado.`;
      keyboard = new InlineKeyboard()
        .text("✅ Sí, eliminar", `admin_menus_delete_confirm_${menuId}`)
        .text("❌ No", "admin_menus_delete_cancel")
        .row()
        .text("◀️ Volver a Gestionar menús", "admin_menus_manage");
    }
  } else if (data.startsWith("admin_menus_delete_confirm_")) {
    const menuId = data.replace("admin_menus_delete_confirm_", "");
    deletingMenuFlow.delete(ctx.from.id);
    if (!isCustomMenu(menuId)) {
      result = "Error: menú no encontrado.";
      keyboard = buildManageMenusKeyboard();
    } else {
      removeCustomMenu(menuId);
      unregisterExtraMenu(menuId);
      await removeMenuFromAllUsers(menuId);
      const label = getExtraMenuLabel(menuId) ?? menuId;
      result = `✅ Menú *${label}* (\`${menuId}\`) eliminado.`;
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar menús", "admin_menus_manage");
    }
  } else if (data === "admin_menus_delete_cancel") {
    deletingMenuFlow.delete(ctx.from.id);
    result = "⚙️ *Gestionar menús*\n\nLista, crea, edita o elimina menús extra.";
    keyboard = buildManageMenusKeyboard();
  } else {
    result = "🔒 *Seguridad* — Gestiona quién puede usar el bot y sus menús.";
    keyboard = buildSecurityKeyboard();
  }

  return { result, keyboard };
}
