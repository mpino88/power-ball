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
  getRequestedPlanUsers,
  approvePlanRequest,
  assignPlanToUser,
  reloadConfigFromStorage,
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
  getPlans,
  getPlanById,
  getPlanByTitle,
  removePlan,
  titleToPlanId,
  updatePlan,
} from "../plans.js";
import {
  buildSecurityKeyboard,
  buildManageMenusKeyboard,
  buildManagePlansKeyboard,
  buildUserMenusKeyboard,
  buildPlanMenusKeyboard,
  formatUserLine,
} from "./keyboards.js";
import {
  addingUserFlow,
  creatingMenuFlow,
  editingMenuFlow,
  deletingMenuFlow,
  creatingPlanFlow,
  editingPlanFlow,
  deletingPlanFlow,
  assigningPlanFlow,
  clearAllFlows,
} from "./flows.js";

const BUILTIN_MENU_IDS = new Set(["est_grupos", "est_individuales"]);

export interface SecurityCallbackDeps {
  buildMainKeyboard: (userId: number | undefined) => InlineKeyboard;
  getExtraMenuIds: () => string[];
  getExtraMenuLabel: (menuId: string) => string | undefined;
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
    await reloadConfigFromStorage();
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
    await reloadConfigFromStorage();
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
    creatingMenuFlow.delete(ctx.from.id);
    editingMenuFlow.delete(ctx.from.id);
    deletingMenuFlow.delete(ctx.from.id);
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
      "➕ *Crear menú* (paso 1/2)\n\nEnvía el *título* del menú (texto del botón). Ej: 📅 Fechas Calor.\n\n" +
      "El _id_ se generará automáticamente (minúsculas, snake_case, sin acentos).";
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
  } else if (data === "admin_plans_manage") {
    result =
      "💰 *Gestionar planes*\n\nLos planes se muestran a usuarios sin acceso. Lista, añade, edita o elimina planes (título, descripción, precio).";
    keyboard = buildManagePlansKeyboard();
  } else if (data === "admin_plans_assign_user") {
    assigningPlanFlow.set(ctx.from.id, { step: 1 });
    result =
      "👤 *Asignar plan a usuario*\n\nEnvía el *ID* del usuario (número de Telegram). El usuario puede ver su ID con /start si no tiene acceso.";
    keyboard = new InlineKeyboard().text("◀️ Cancelar", "admin_assign_plan_cancel");
  } else if (data.startsWith("admin_assign_plan_") && !data.startsWith("admin_assign_plan_cancel")) {
    const planId = data.replace("admin_assign_plan_", "");
    const plan = getPlanById(planId);
    const flow = assigningPlanFlow.get(ctx.from.id);
    if (!plan || !flow || flow.step !== 2) {
      result = plan ? "Sesión expirada. Vuelve a *Asignar plan a usuario* e introduce el ID." : "Plan no encontrado.";
      keyboard = buildManagePlansKeyboard();
      if (flow) assigningPlanFlow.delete(ctx.from.id);
    } else {
      const targetUserId = flow.targetUserId;
      assigningPlanFlow.delete(ctx.from.id);
      const assignResult = await assignPlanToUser(targetUserId, plan.title, plan.menuIds ?? []);
      if (assignResult.ok) {
        result = `✅ Plan *${plan.title}* asignado al usuario \`${targetUserId}\`. Menús del plan aplicados.`;
      } else {
        result = (assignResult.error ?? "Error al guardar.") + "\n\nVuelve a intentar desde *Asignar plan a usuario*.";
      }
      keyboard = buildManagePlansKeyboard();
    }
  } else if (data === "admin_assign_plan_cancel") {
    assigningPlanFlow.delete(ctx.from.id);
    result = "💰 *Gestionar planes*\n\nOperación cancelada.";
    keyboard = buildManagePlansKeyboard();
  } else if (data === "admin_plans_list") {
    const list = getPlans();
    const lines = list.map((p) => {
      const menus = (p.menuIds?.length ? p.menuIds.join(", ") : "—") || "—";
      return `• *${p.title}* — ${p.price}\n  _${p.description.slice(0, 50)}${p.description.length > 50 ? "…" : ""}_\n  Menús: \`${menus}\``;
    });
    result = "📋 *Planes*\n\n" + (lines.length ? lines.join("\n\n") : "_Ningún plan. Añade uno desde Gestionar planes._");
    keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar planes", "admin_plans_manage");
  } else if (data === "admin_plans_add") {
    creatingPlanFlow.set(ctx.from.id, { step: 1 });
    result =
      "➕ *Añadir plan* (paso 1/4)\n\nEnvía el *título* del plan (ej: Plan Básico).\n\n/cancel para cancelar.";
    keyboard = new InlineKeyboard().text("◀️ Cancelar", "admin_plans_manage");
  } else if (data === "admin_plans_edit") {
    const list = getPlans();
    if (list.length === 0) {
      result = "✏️ *Editar plan*\n\n_No hay planes._ Añade uno primero.";
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar planes", "admin_plans_manage");
    } else {
      result = "✏️ *Editar plan*\n\nElige el plan a editar:";
      keyboard = new InlineKeyboard();
      for (const p of list) {
        keyboard.text(`✏️ ${p.title} (${p.price})`, `admin_plans_edit_pick_${p.id}`).row();
      }
      keyboard.text("◀️ Volver a Gestionar planes", "admin_plans_manage");
    }
  } else if (data.startsWith("admin_plans_edit_pick_")) {
    const planId = data.replace("admin_plans_edit_pick_", "");
    const plan = getPlanById(planId);
    if (!plan) {
      result = "Error: plan no encontrado.";
      keyboard = buildManagePlansKeyboard();
    } else {
      editingPlanFlow.set(ctx.from.id, { step: 1, planId });
      result =
        `✏️ *Editar plan* — ${plan.title}\n\nEnvía el *nuevo título* (ahora: ${plan.title}).\n\n/cancel para cancelar.`;
      keyboard = new InlineKeyboard().text("◀️ Cancelar", "admin_plans_manage");
    }
  } else if (data === "admin_plans_delete") {
    const list = getPlans();
    if (list.length === 0) {
      result = "🗑 *Eliminar plan*\n\n_No hay planes._";
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar planes", "admin_plans_manage");
    } else {
      result = "🗑 *Eliminar plan*\n\nElige el plan a eliminar:";
      keyboard = new InlineKeyboard();
      for (const p of list) {
        keyboard.text(`🗑 ${p.title}`, `admin_plans_delete_pick_${p.id}`).row();
      }
      keyboard.text("◀️ Volver a Gestionar planes", "admin_plans_manage");
    }
  } else if (data.startsWith("admin_plans_delete_pick_")) {
    const planId = data.replace("admin_plans_delete_pick_", "");
    const plan = getPlanById(planId);
    if (!plan) {
      result = "Error: plan no encontrado.";
      keyboard = buildManagePlansKeyboard();
    } else {
      deletingPlanFlow.set(ctx.from.id, { planId });
      result = `🗑 ¿Eliminar el plan *${plan.title}* (${plan.price})?`;
      keyboard = new InlineKeyboard()
        .text("✅ Sí, eliminar", `admin_plans_delete_confirm_${planId}`)
        .text("❌ No", "admin_plans_delete_cancel")
        .row()
        .text("◀️ Volver a Gestionar planes", "admin_plans_manage");
    }
  } else if (data.startsWith("admin_plans_delete_confirm_")) {
    const planId = data.replace("admin_plans_delete_confirm_", "");
    deletingPlanFlow.delete(ctx.from.id);
    const plan = getPlanById(planId);
    if (!plan) {
      result = "Error: plan no encontrado.";
      keyboard = buildManagePlansKeyboard();
    } else {
      removePlan(planId);
      result = `✅ Plan *${plan.title}* eliminado.`;
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar planes", "admin_plans_manage");
    }
  } else if (data === "admin_plans_delete_cancel") {
    deletingPlanFlow.delete(ctx.from.id);
    result = "💰 *Gestionar planes*\n\nLista, añade, edita o elimina planes.";
    keyboard = buildManagePlansKeyboard();
  } else if (data === "admin_plans_menus") {
    const list = getPlans();
    if (list.length === 0) {
      result = "📋 *Menús por plan*\n\n_No hay planes._ Crea uno primero.";
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar planes", "admin_plans_manage");
    } else {
      result = "📋 *Menús por plan*\n\nElige el plan al que quieres asociar o desasociar menús:";
      keyboard = new InlineKeyboard();
      for (const p of list) {
        const menuCount = p.menuIds?.length ?? 0;
        keyboard.text(`📋 ${p.title} (${menuCount} menús)`, `admin_plans_menus_pick_${p.id}`).row();
      }
      keyboard.text("◀️ Volver a Gestionar planes", "admin_plans_manage");
    }
  } else if (data.startsWith("admin_plans_menus_pick_")) {
    const planId = data.replace("admin_plans_menus_pick_", "");
    const plan = getPlanById(planId);
    if (!plan) {
      result = "Plan no encontrado.";
      keyboard = buildManagePlansKeyboard();
    } else {
      result = `📋 *Menús del plan: ${plan.title}*\n\n➕ = añadir menú al plan\n➖ = quitar menú del plan\n\nLos usuarios aprobados con este plan recibirán estos menús.`;
      keyboard = buildPlanMenusKeyboard(planId, deps.getExtraMenuIds, deps.getExtraMenuLabel, getPlanById);
    }
  } else if (data.startsWith("admin_plan_menu_add_")) {
    const rest = data.slice("admin_plan_menu_add_".length);
    const [planId, menuId] = rest.split("|");
    if (planId && menuId) {
      const plan = getPlanById(planId);
      if (plan) {
        const current = plan.menuIds ?? [];
        if (!current.includes(menuId)) {
          updatePlan(planId, { menuIds: [...current, menuId] });
        }
        result = `📋 *Menús del plan: ${plan.title}*\n\n✅ Menú \`${menuId}\` asociado.`;
        keyboard = buildPlanMenusKeyboard(planId, deps.getExtraMenuIds, deps.getExtraMenuLabel, getPlanById);
      } else {
        result = "Plan no encontrado.";
        keyboard = buildManagePlansKeyboard();
      }
    } else {
      result = "Error al procesar.";
      keyboard = buildManagePlansKeyboard();
    }
  } else if (data.startsWith("admin_plan_menu_remove_")) {
    const rest = data.slice("admin_plan_menu_remove_".length);
    const [planId, menuId] = rest.split("|");
    if (planId && menuId) {
      const plan = getPlanById(planId);
      if (plan) {
        const current = (plan.menuIds ?? []).filter((m) => m !== menuId);
        updatePlan(planId, { menuIds: current });
        result = `📋 *Menús del plan: ${plan.title}*\n\nMenú \`${menuId}\` desasociado.`;
        keyboard = buildPlanMenusKeyboard(planId, deps.getExtraMenuIds, deps.getExtraMenuLabel, getPlanById);
      } else {
        result = "Plan no encontrado.";
        keyboard = buildManagePlansKeyboard();
      }
    } else {
      result = "Error al procesar.";
      keyboard = buildManagePlansKeyboard();
    }
  } else if (data === "admin_plans_requests" || data === "admin_plans_requests_refresh") {
    if (data === "admin_plans_requests_refresh") await reloadConfigFromStorage();
    const requested = getRequestedPlanUsers();
    if (requested.length === 0) {
      result =
        "📩 *Solicitudes pendientes*\n\nNo hay solicitudes. Cuando un usuario sin acceso elija un plan y envíe su teléfono, aparecerán aquí.";
      keyboard = new InlineKeyboard()
        .text("🔄 Actualizar desde Sheet", "admin_plans_requests_refresh")
        .row()
        .text("◀️ Volver a Gestionar planes", "admin_plans_manage");
    } else {
      result =
        "📩 *Solicitudes pendientes* (plan_status = requested)\n\nAprueba para dar acceso y asignar menús del plan:\n\n" +
        requested
          .map((u) => {
            const name = u.name || "—";
            const phone = u.phone ? `📞 ${u.phone}` : "—";
            return `• \`${u.userId}\` — *${u.plan}*\n  ${name} — ${phone}`;
          })
          .join("\n\n");
      keyboard = new InlineKeyboard();
      for (const u of requested) {
        const label = u.name ? `✅ ${u.userId} — ${u.plan} (${u.name})` : `✅ Aprobar ${u.userId} (${u.plan})`;
        keyboard.text(label, `admin_plans_approve_${u.userId}`).row();
      }
      keyboard.text("🔄 Actualizar lista", "admin_plans_requests_refresh").row().text("◀️ Volver a Gestionar planes", "admin_plans_manage");
    }
  } else if (data.startsWith("admin_plans_approve_")) {
    const userIdStr = data.replace("admin_plans_approve_", "");
    const userId = parseInt(userIdStr, 10);
    if (Number.isNaN(userId)) {
      result = "ID de usuario inválido.";
      keyboard = buildManagePlansKeyboard();
    } else {
      const requested = getRequestedPlanUsers().find((u) => u.userId === userId);
      const plan = requested ? getPlanByTitle(requested.plan) : undefined;
      const planMenuIds = plan?.menuIds ?? [];
      const approveResult = await approvePlanRequest(userId, planMenuIds);
      if (approveResult.ok) {
        const menuInfo = planMenuIds.length > 0 ? ` Menús del plan: ${planMenuIds.join(", ")}.` : "";
        result = `✅ Usuario \`${userId}\` aprobado. Ya tiene acceso al bot.${menuInfo} Puedes asignar más menús en *Menús por usuario*.`;
      } else {
        result = (approveResult.error ?? "Error al aprobar.") + "\n\nVuelve a Solicitudes pendientes.";
      }
      keyboard = buildManagePlansKeyboard();
    }
  } else {
    result = "🔒 *Seguridad* — Gestiona quién puede usar el bot y sus menús.";
    keyboard = buildSecurityKeyboard();
  }

  return { result, keyboard };
}
