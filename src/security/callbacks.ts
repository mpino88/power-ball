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
  getPlan,
  getPlanStatus,
  getOwnerId,
  addAllowed,
  removeAllowed,
  setUserInfo,
  toggleExtraMenu,
  getExtraMenus,
  getUserAssignedMenuIds,
  removeMenuFromUser,
  removeMenuFromAllUsers,
  getRequestedPlanUsers,
  approvePlanRequest,
  assignPlanToUser,
  reloadConfigFromStorage,
  addStrategyRequest,
  getStrategyRequests,
  removeStrategyRequest,
  approveStrategyRequest,
} from "../user-config.js";
import {
  getExtraMenuIds,
  getExtraMenuLabel,
  getExtraMenuStatus,
  unregisterExtraMenu,
  updateExtraMenuLabel,
} from "../menu-registry.js";
import {
  getCustomMenus,
  getCustomMenusCreatedBy,
  isCustomMenu,
  canDeleteCustomMenu,
  addCustomMenu,
  updateCustomMenu,
  removeCustomMenu,
  getMenuPrice,
  getMenuVisibility,
  getPublicStrategies,
  canChangeVisibility,
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
  buildManageEstrategiasKeyboard,
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

/** Escapa caracteres especiales de Telegram Markdown (legacy) para evitar "can't parse entities". */
function escapeMd(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/_/g, "\\_").replace(/\*/g, "\\*").replace(/`/g, "\\`").replace(/\[/g, "\\[");
}

export interface SecurityCallbackDeps {
  buildMainKeyboard: (userId: number | undefined) => InlineKeyboard;
  getExtraMenuIds: () => string[];
  getExtraMenuLabel: (menuId: string) => string | undefined;
  /** Si se proporciona, "Listar planes" recarga desde el Sheet antes de mostrar. */
  getStorageBackend?: () => "sheet" | "file";
  loadPlansFromSheet?: () => Promise<{ id: string; title: string; description: string; price: string; menuIds: string }[]>;
  initPlansFromSheet?: (rows: { id: string; title: string; description: string; price: string; menuIds: string }[]) => void;
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
    const slice = list.slice(0, 30);
    const lines = slice.map((uid) => {
      const name = escapeMd((getUsername(uid) || "").trim() || "—");
      const phone = escapeMd((getPhone(uid) || "").trim() || "—");
      const plan = escapeMd((getPlan(uid) || "").trim() || "—");
      const status = escapeMd((getPlanStatus(uid) || "").trim() || "—");
      return `• *ID:* \`${uid}\` | *Nombre:* ${name} | *Teléfono:* ${phone}\n  *Plan:* ${plan} | *Estado:* ${status}`;
    });
    result =
      "👥 *Listar usuarios* (" + list.length + ")\n\n" +
      "Toda la info del usuario. Usa *Agregar acceso* o *Quitar acceso* para gestionar.\n\n" +
      (lines.length ? lines.join("\n\n") : "_Ningún usuario con acceso_ (solo tú como dueño).");
    keyboard = new InlineKeyboard().text("➕ Agregar acceso", "admin_add").row();
    const ownerId = getOwnerId();
    for (const uid of slice) {
      if (ownerId !== null && uid === ownerId) continue;
      const label = getUsername(uid) ? `➖ Quitar ${getUsername(uid)}` : `➖ Quitar ${uid}`;
      keyboard.text(label.length > 64 ? `➖ Quitar ${uid}` : label, `admin_revoke_${uid}`).row();
    }
    keyboard.text("◀️ Volver a Seguridad", "security_open");
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
  } else if (data === "admin_estrategias_manage") {
    creatingMenuFlow.delete(ctx.from.id);
    deletingMenuFlow.delete(ctx.from.id);
    result =
      "⚙️ *Gestionar Estrategias*\n\nLista, crea o elimina estrategias. Asigna estrategias a usuarios desde aquí.";
    keyboard = buildManageEstrategiasKeyboard();
  } else if (data === "admin_estrategias_list") {
    const ids = getExtraMenuIds();
    const builtIn = ids.filter((id) => BUILTIN_MENU_IDS.has(id));
    const custom = ids.filter((id) => isCustomMenu(id));
    const statusLabel = (id: string) => (getExtraMenuStatus(id) === "implemented" ? "✅ implementada" : "⏳ _pendiente_");
    const lines = [
      ...builtIn.map((id) => `• ${getExtraMenuLabel(id) ?? id} (\`${id}\`) — _integrado_ — ${statusLabel(id)}`),
      ...custom.map((id) => `• ${getExtraMenuLabel(id) ?? id} (\`${id}\`) — ${statusLabel(id)}`),
    ];
    result =
      "📋 *Listar estrategias*\n\n" +
      (lines.length ? lines.join("\n") + "\n\n_✅ implementada_ = con función asignada · _⏳ pendiente_ = sin función (mensaje por defecto)." : "_Ninguna_");
    keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar Estrategias", "admin_estrategias_manage");
  } else if (data === "admin_estrategias_create") {
    creatingMenuFlow.set(ctx.from.id, { step: 1, createdBy: ctx.from.id, fromAdmin: true });
    result =
      "➕ *Crear estrategia* (paso 1/3)\n\nEnvía el *título* (texto del botón). Ej: 📅 Fechas Calor.\n\n" +
      "El id se generará automáticamente (minúsculas, snake\\_case, sin acentos).";
    keyboard = new InlineKeyboard().text("◀️ Cancelar", "admin_estrategias_manage");
  } else if (data === "admin_estrategias_delete") {
    const custom = getCustomMenus();
    if (custom.length === 0) {
      result =
        "🗑 *Eliminar estrategia*\n\n_No hay estrategias creadas._ Solo se pueden eliminar las personalizadas.";
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar Estrategias", "admin_estrategias_manage");
    } else {
      result =
        "🗑 *Eliminar estrategia*\n\nElige la estrategia a eliminar (se quitará de todos los usuarios):";
      keyboard = new InlineKeyboard();
      for (const m of custom) {
        keyboard.text(`🗑 ${m.label}`, `admin_estrategias_delete_pick_${m.id}`).row();
      }
      keyboard.text("◀️ Volver a Gestionar Estrategias", "admin_estrategias_manage");
    }
  } else if (data.startsWith("admin_estrategias_delete_pick_")) {
    const menuId = data.replace("admin_estrategias_delete_pick_", "");
    if (!isCustomMenu(menuId)) {
      result = "Error: estrategia no encontrada.";
      keyboard = buildManageEstrategiasKeyboard();
    } else {
      deletingMenuFlow.set(ctx.from.id, { menuId });
      const label = getExtraMenuLabel(menuId) ?? menuId;
      result = `🗑 ¿Eliminar la estrategia *${escapeMd(label)}* (\`${menuId}\`)?\n\nSe quitará de todos los usuarios que la tengan asignada.`;
      keyboard = new InlineKeyboard()
        .text("✅ Sí, eliminar", `admin_estrategias_delete_confirm_${menuId}`)
        .text("❌ No", "admin_estrategias_delete_cancel")
        .row()
        .text("◀️ Volver a Gestionar Estrategias", "admin_estrategias_manage");
    }
  } else if (data.startsWith("admin_estrategias_delete_confirm_")) {
    const menuId = data.replace("admin_estrategias_delete_confirm_", "");
    deletingMenuFlow.delete(ctx.from.id);
    if (!isCustomMenu(menuId)) {
      result = "Error: estrategia no encontrada.";
      keyboard = buildManageEstrategiasKeyboard();
    } else {
      removeCustomMenu(menuId);
      unregisterExtraMenu(menuId);
      await removeMenuFromAllUsers(menuId);
      const label = getExtraMenuLabel(menuId) ?? menuId;
      result = `✅ Estrategia *${escapeMd(label)}* (\`${menuId}\`) eliminada.`;
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar Estrategias", "admin_estrategias_manage");
    }
  } else if (data === "admin_estrategias_delete_cancel") {
    deletingMenuFlow.delete(ctx.from.id);
    result = "⚙️ *Gestionar Estrategias*\n\nLista, crea o elimina estrategias.";
    keyboard = buildManageEstrategiasKeyboard();
  } else if (data === "admin_estrategias_requests") {
    const requests = await getStrategyRequests();
    if (requests.length === 0) {
      result = "📥 *Solicitudes pendientes*\n\n_No hay solicitudes de estrategias._";
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar Estrategias", "admin_estrategias_manage");
    } else {
      result = "📥 *Solicitudes pendientes*\n\nUsuario · Estrategia\n\n";
      for (const r of requests) {
        const userLine = formatUserLine(r.userId, getUsername, getPhone);
        const strategyLabel = getExtraMenuLabel(r.menuId) ?? r.menuId;
        result += `• ${userLine}\n  Estrategia: ${escapeMd(strategyLabel)} (\`${r.menuId}\`)\n\n`;
      }
      keyboard = new InlineKeyboard();
      for (const r of requests) {
        const payload = `${r.userId}|${r.menuId}`;
        keyboard
          .text(`✅ Aprobar`, `admin_estrategias_approve_${payload}`)
          .text(`❌ Rechazar`, `admin_estrategias_reject_${payload}`)
          .row();
      }
      keyboard.text("◀️ Volver a Gestionar Estrategias", "admin_estrategias_manage");
    }
  } else if (data.startsWith("admin_estrategias_approve_")) {
    const rest = data.replace("admin_estrategias_approve_", "");
    const [uidStr, ...menuIdParts] = rest.split("|");
    const menuId = menuIdParts.join("|");
    const uid = parseInt(uidStr, 10);
    if (Number.isNaN(uid) || !menuId) {
      result = "Solicitud no encontrada.";
      keyboard = buildManageEstrategiasKeyboard();
    } else {
      await approveStrategyRequest(uid, menuId);
      const label = getExtraMenuLabel(menuId) ?? menuId;
      result = `✅ Solicitud aprobada: usuario \`${uid}\` — *${escapeMd(label)}* (\`${menuId}\`).`;
      keyboard = new InlineKeyboard().text("◀️ Volver a Solicitudes", "admin_estrategias_requests");
    }
  } else if (data.startsWith("admin_estrategias_reject_")) {
    const rest = data.replace("admin_estrategias_reject_", "");
    const [uidStr, ...menuIdParts] = rest.split("|");
    const menuId = menuIdParts.join("|");
    const uid = parseInt(uidStr, 10);
    if (Number.isNaN(uid) || !menuId) {
      result = "Solicitud no encontrada.";
      keyboard = buildManageEstrategiasKeyboard();
    } else {
      await removeStrategyRequest(uid, menuId);
      const label = getExtraMenuLabel(menuId) ?? menuId;
      result = `❌ Solicitud rechazada: usuario \`${uid}\` — *${escapeMd(label)}*.`;
      keyboard = new InlineKeyboard().text("◀️ Volver a Solicitudes", "admin_estrategias_requests");
    }
  } else if (data === "admin_estrategias_visibility") {
    const custom = getCustomMenus();
    if (custom.length === 0) {
      result = "🌐 *Visibilidad*\n\n_No hay estrategias._";
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar Estrategias", "admin_estrategias_manage");
    } else {
      result = "🌐 *Visibilidad*\n\nSolo el creador y el dueño pueden cambiar. _Pública_ = visible en Tienda.\n\n";
      for (const m of custom) {
        const vis = getMenuVisibility(m.id) === "public" ? "🌐 pública" : "🔒 privada";
        result += `• ${escapeMd(m.label)} (\`${m.id}\`) — ${vis}\n`;
      }
      keyboard = new InlineKeyboard();
      for (const m of custom) {
        const next = getMenuVisibility(m.id) === "public" ? "🔒 Ocultar" : "🌐 Publicar";
        keyboard.text(`${next}: ${m.label}`, `admin_estrategias_visibility_toggle_${m.id}`).row();
      }
      keyboard.text("◀️ Volver a Gestionar Estrategias", "admin_estrategias_manage");
    }
  } else if (data.startsWith("admin_estrategias_visibility_toggle_")) {
    const menuId = data.replace("admin_estrategias_visibility_toggle_", "");
    if (!isCustomMenu(menuId)) {
      result = "Estrategia no encontrada.";
      keyboard = buildManageEstrategiasKeyboard();
    } else {
      const next = getMenuVisibility(menuId) === "public" ? "private" : "public";
      updateCustomMenu(menuId, { visibility: next });
      const label = getExtraMenuLabel(menuId) ?? menuId;
      result = next === "public"
        ? `🌐 *${escapeMd(label)}* (\`${menuId}\`) ahora es *pública* (visible en Tienda).`
        : `🔒 *${escapeMd(label)}* (\`${menuId}\`) ahora es *privada* (solo creador y dueño).`;
      keyboard = new InlineKeyboard().text("◀️ Volver a Visibilidad", "admin_estrategias_visibility");
    }
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
    if (deps.getStorageBackend?.() === "sheet" && deps.loadPlansFromSheet && deps.initPlansFromSheet) {
      const rows = await deps.loadPlansFromSheet();
      deps.initPlansFromSheet(rows);
    }
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
    await reloadConfigFromStorage();
    const requested = getRequestedPlanUsers();
    if (requested.length === 0) {
      result =
        "📩 *Solicitudes pendientes*\n\nNo hay solicitudes. Cuando un usuario sin acceso elija un plan y envíe su teléfono, aparecerán aquí.";
      keyboard = new InlineKeyboard()
        .text("🔄 Actualizar desde Sheet", "admin_plans_requests_refresh")
        .row()
        .text("◀️ Volver a Gestionar planes", "admin_plans_manage");
    } else {
      const lines = requested.map((u) => {
        const id = String(u.userId);
        const plan = escapeMd(u.plan || "—");
        const nombre = escapeMd((u.name && u.name.trim()) ? u.name.trim() : "—");
        const telefono = escapeMd((u.phone && u.phone.trim()) ? u.phone.trim() : "—");
        return `• *ID:* \`${id}\` | *Plan:* ${plan}\n  *Nombre:* ${nombre} | *Teléfono:* ${telefono}`;
      });
      result =
        "📩 *Solicitudes pendientes* (plan\\_status = requested)\n\nSe muestran todos los datos cargados del Sheet/archivo:\n\n" +
        lines.join("\n\n");
      keyboard = new InlineKeyboard();
      for (const u of requested) {
        const displayName = (u.name && u.name.trim()) ? u.name.trim() : null;
        const label = displayName ? `✅ ${u.userId} — ${u.plan} (${displayName})` : `✅ Aprobar ${u.userId} (${u.plan})`;
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

export interface EstrategiasUserCallbackDeps {
  getExtraMenuIds: () => string[];
  getExtraMenuLabel: (id: string) => string | undefined;
  getExtraMenus: (userId: number) => string[];
  getUserAssignedMenuIds: (userId: number) => string[];
  getPlan?: (userId: number) => string | undefined;
  getPlanByTitle?: (title: string) => { menuIds?: string[] } | undefined;
  getMenuCreatedBy?: (menuId: string) => number | undefined;
  getOwnerId: () => number | null;
  buildMainKeyboard: (userId: number | undefined) => InlineKeyboard;
}

/** Gestionar estrategias para cualquier usuario (listar, crear, eliminar propias). */
export async function handleEstrategiasUserCallback(
  ctx: Context,
  data: string,
  deps: EstrategiasUserCallbackDeps
): Promise<{ result: string; keyboard: InlineKeyboard } | null> {
  const userId = ctx.from?.id;
  if (userId === undefined) return null;

  let result: string;
  let keyboard: InlineKeyboard;

  if (data === "estrategias_manage") {
    creatingMenuFlow.delete(userId);
    deletingMenuFlow.delete(userId);
    result = "⚙️ *Gestionar estrategias*\n\nLista, crea o elimina tus estrategias. Las que crees se te asignan automáticamente.";
    keyboard = new InlineKeyboard()
      .text("📋 Listar estrategias", "estrategias_list")
      .text("🛒 Tienda", "estrategias_tienda")
      .row()
      .text("➕ Crear estrategia", "estrategias_create")
      .text("🗑 Eliminar estrategia", "estrategias_delete")
      .row();
    const createdByMe = getCustomMenusCreatedBy(userId);
    if (createdByMe.length > 0) {
      keyboard.text("🌐 Visibilidad (pública/privada)", "estrategias_visibility").row();
    }
    keyboard.text("◀️ Volver", "volver");
    return { result, keyboard };
  }

  if (data === "estrategias_tienda") {
    result = "🛒 *Tienda*\n\n*Mis estrategias*: las que creaste y las que has adquirido.\n*En venta*: estrategias públicas que puedes solicitar.";
    keyboard = new InlineKeyboard()
      .text("📋 Mis estrategias", "estrategias_tienda_mias")
      .text("🛍 En venta", "estrategias_tienda_venta")
      .row()
      .text("◀️ Volver a Gestionar", "estrategias_manage");
    return { result, keyboard };
  }

  if (data === "estrategias_tienda_mias") {
    const planTitle = deps.getPlan?.(userId);
    const plan = planTitle ? deps.getPlanByTitle?.(planTitle) : undefined;
    const planMenuIds = new Set((plan && "menuIds" in plan ? plan.menuIds : undefined) ?? []);
    const extraMenus = deps.getExtraMenus(userId);
    const createdByMe = getCustomMenusCreatedBy(userId);
    const createdIds = new Set(createdByMe.map((m) => m.id));
    const acquiredIds = extraMenus.filter((id) => !planMenuIds.has(id));
    const showIds = [...new Set([...createdIds, ...acquiredIds])].filter((id) =>
      deps.getExtraMenuIds().includes(id)
    );
    if (showIds.length === 0) {
      result = "📋 *Mis estrategias*\n\n_No tienes estrategias propias ni adquiridas._";
      keyboard = new InlineKeyboard().text("◀️ Volver a Tienda", "estrategias_tienda");
      return { result, keyboard };
    }
    result = "📋 *Mis estrategias*\n\nCreadas por ti y las que has adquirido (no incluye las de tu plan).\n\n";
    for (const id of showIds) {
      const label = deps.getExtraMenuLabel(id) ?? id;
      const m = getCustomMenus().find((x) => x.id === id);
      const price = m?.price;
      const priceStr = price ? ` — ${escapeMd(price)}` : "";
      const tag = createdIds.has(id) ? " _creada por ti_" : " _adquirida_";
      result += `• ${escapeMd(label)} (\`${id}\`)${priceStr}${tag}\n`;
    }
    keyboard = new InlineKeyboard().text("◀️ Volver a Tienda", "estrategias_tienda");
    return { result, keyboard };
  }

  if (data === "estrategias_tienda_venta") {
    const myIds = new Set(deps.getExtraMenus(userId));
    const publicList = getPublicStrategies().filter((m) => !myIds.has(m.id));
    if (publicList.length === 0) {
      result = "🛍 *En venta*\n\n_No hay estrategias públicas disponibles o ya tienes todas._";
      keyboard = new InlineKeyboard().text("◀️ Volver a Tienda", "estrategias_tienda");
      return { result, keyboard };
    }
    result = "🛍 *En venta*\n\nEstrategias públicas que puedes solicitar. Solo el administrador puede aprobar tu solicitud.\n\n";
    for (const m of publicList) {
      const priceStr = m.price ? ` — ${escapeMd(m.price)}` : "";
      const authorTag = m.createdBy === userId ? " _creada por ti_" : " _creada por otro_";
      result += `• ${escapeMd(m.label)} (\`${m.id}\`)${priceStr}${authorTag}\n`;
    }
    keyboard = new InlineKeyboard();
    for (const m of publicList) {
      keyboard.text(`📥 Solicitar: ${m.label}`, `estrategias_request_${m.id}`).row();
    }
    keyboard.text("◀️ Volver a Tienda", "estrategias_tienda");
    return { result, keyboard };
  }

  if (data.startsWith("estrategias_request_")) {
    const menuId = data.replace("estrategias_request_", "");
    const ownerId = deps.getOwnerId();
    const createdBy = deps.getMenuCreatedBy?.(menuId);
    if (userId === ownerId || createdBy === userId) {
      result = "Solo otros usuarios pueden solicitar esta estrategia.";
      keyboard = new InlineKeyboard().text("◀️ Volver a En venta", "estrategias_tienda_venta");
      return { result, keyboard };
    }
    if (!isCustomMenu(menuId) || getMenuVisibility(menuId) !== "public") {
      result = "Estrategia no disponible.";
      keyboard = new InlineKeyboard().text("◀️ Volver a En venta", "estrategias_tienda_venta");
      return { result, keyboard };
    }
    if (deps.getExtraMenus(userId).includes(menuId)) {
      result = "Ya tienes acceso a esta estrategia.";
      keyboard = new InlineKeyboard().text("◀️ Volver a En venta", "estrategias_tienda_venta");
      return { result, keyboard };
    }
    const added = await addStrategyRequest(userId, menuId);
    const label = deps.getExtraMenuLabel(menuId) ?? menuId;
    result = added
      ? `✅ Solicitud enviada: *${escapeMd(label)}* (\`${menuId}\`). El administrador la revisará.`
      : "Ya tenías una solicitud pendiente para esta estrategia.";
    keyboard = new InlineKeyboard().text("◀️ Volver a En venta", "estrategias_tienda_venta");
    return { result, keyboard };
  }

  if (data === "estrategias_visibility") {
    const ownerId = deps.getOwnerId();
    const isOwnerUser = ownerId !== null && userId === ownerId;
    const list = isOwnerUser ? getCustomMenus() : getCustomMenusCreatedBy(userId);
    if (list.length === 0) {
      result = "🌐 *Visibilidad*\n\n_No tienes estrategias propias que puedas publicar._";
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar", "estrategias_manage");
      return { result, keyboard };
    }
    result = "🌐 *Visibilidad*\n\n_Pública_ = visible en Tienda para que otros usuarios puedan solicitarla.\n\n";
    for (const m of list) {
      const vis = getMenuVisibility(m.id) === "public" ? "🌐 pública" : "🔒 privada";
      result += `• ${escapeMd(m.label)} (\`${m.id}\`) — ${vis}\n`;
    }
    keyboard = new InlineKeyboard();
    for (const m of list) {
      if (!canChangeVisibility(m.id, userId, isOwnerUser)) continue;
      const next = getMenuVisibility(m.id) === "public" ? "🔒 Ocultar" : "🌐 Publicar";
      keyboard.text(`${next}: ${m.label}`, `estrategias_visibility_toggle_${m.id}`).row();
    }
    keyboard.text("◀️ Volver a Gestionar", "estrategias_manage");
    return { result, keyboard };
  }

  if (data.startsWith("estrategias_visibility_toggle_")) {
    const menuId = data.replace("estrategias_visibility_toggle_", "");
    const ownerId = deps.getOwnerId();
    const isOwnerUser = ownerId !== null && userId === ownerId;
    if (!canChangeVisibility(menuId, userId, isOwnerUser)) {
      result = "No puedes cambiar la visibilidad de esta estrategia.";
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar", "estrategias_manage");
      return { result, keyboard };
    }
    if (!isCustomMenu(menuId)) {
      result = "Estrategia no encontrada.";
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar", "estrategias_manage");
      return { result, keyboard };
    }
    const next = getMenuVisibility(menuId) === "public" ? "private" : "public";
    updateCustomMenu(menuId, { visibility: next });
    const label = deps.getExtraMenuLabel(menuId) ?? menuId;
    result = next === "public"
      ? `🌐 *${escapeMd(label)}* (\`${menuId}\`) ahora es *pública* (visible en Tienda).`
      : `🔒 *${escapeMd(label)}* (\`${menuId}\`) ahora es *privada*.`;
    keyboard = new InlineKeyboard().text("◀️ Volver a Visibilidad", "estrategias_visibility");
    return { result, keyboard };
  }

  if (data === "estrategias_list") {
    const assignedIds = deps.getExtraMenus(userId);
    const createdByMe = getCustomMenusCreatedBy(userId);
    const allIds = getExtraMenuIds();
    const assignedSet = new Set(assignedIds);
    const createdSet = new Set(createdByMe.map((m) => m.id));
    const ownerId = deps.getOwnerId();
    const isOwnerUser = ownerId !== null && userId === ownerId;
    const getIcon = (menuId: string): string => {
      const createdBy = deps.getMenuCreatedBy?.(menuId);
      if (isOwnerUser) {
        if (createdBy === undefined || createdBy === 0 || createdBy === ownerId) return "👤 ";
        return "👥 ";
      }
      if (createdBy === userId) return "✏️ ";
      const planTitle = deps.getPlan?.(userId);
      const plan = planTitle ? deps.getPlanByTitle?.(planTitle) : undefined;
      if ((plan && "menuIds" in plan ? plan.menuIds : undefined)?.includes(menuId)) return "📋 ";
      if ((deps.getUserAssignedMenuIds(userId) ?? []).includes(menuId)) return "➕ ";
      return "";
    };
    const planTitle = deps.getPlan?.(userId);
    const plan = planTitle ? deps.getPlanByTitle?.(planTitle) : undefined;
    const planMenuIds = (plan && "menuIds" in plan ? plan.menuIds : undefined) ?? [];
    const lines: string[] = [];
    for (const id of allIds) {
      if (!assignedSet.has(id) && !createdSet.has(id)) continue;
      const label = deps.getExtraMenuLabel(id) ?? id;
      const icon = getIcon(id);
      let suffix = BUILTIN_MENU_IDS.has(id) ? " — _integrado_" : createdSet.has(id) ? " — _creada por ti_" : "";
      if (!isOwnerUser && assignedSet.has(id) && !planMenuIds.includes(id)) {
        const price = getMenuPrice(id);
        if (price) suffix += ` — ${escapeMd(price)}`;
      }
      lines.push(`• ${icon}${escapeMd(label)} (\`${id}\`)${suffix}`);
    }
    const legend = isOwnerUser
      ? "\n_👤 propia · 👥 creada por un usuario_"
      : "\n_📋 plan · ➕ adquirida · ✏️ propia_";
    result =
      "📋 *Tus estrategias*" +
      legend +
      "\n\n" +
      (lines.length ? lines.join("\n") : "_Ninguna asignada ni creada por ti._");
    keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar", "estrategias_manage");
    return { result, keyboard };
  }

  if (data === "estrategias_create") {
    creatingMenuFlow.set(userId, { step: 1, createdBy: userId });
    result =
      "➕ *Crear estrategia* (paso 1/3)\n\nEnvía el *título* (texto del botón). Ej: 📅 Fechas Calor.\n\nSe te asignará automáticamente.";
    keyboard = new InlineKeyboard().text("◀️ Cancelar", "estrategias_manage");
    return { result, keyboard };
  }

  if (data === "estrategias_delete") {
    const ownerId = deps.getOwnerId();
    const isOwnerUser = ownerId !== null && userId === ownerId;
    const list = isOwnerUser
      ? getCustomMenus()
      : deps.getUserAssignedMenuIds(userId).filter((id) => deps.getExtraMenuIds().includes(id));
    if (list.length === 0) {
      result = isOwnerUser
        ? "🗑 *Eliminar estrategia*\n\n_No hay estrategias._"
        : "🗑 *Quitar estrategia*\n\n_No tienes estrategias asignadas que puedas quitar._ Solo se pueden quitar las de tu columna menus.";
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar", "estrategias_manage");
      return { result, keyboard };
    }
    result = isOwnerUser
      ? "🗑 *Eliminar estrategia*\n\nElige la estrategia a eliminar del sistema (se quitará de todos los usuarios):"
      : "🗑 *Quitar estrategia*\n\nElige la estrategia a quitar de tus asignadas (solo se quitará de tu columna menus):";
    keyboard = new InlineKeyboard();
    for (const item of list) {
      const id = typeof item === "string" ? item : item.id;
      const label = deps.getExtraMenuLabel(id) ?? id;
      keyboard.text(`🗑 ${label}`, `estrategias_delete_pick_${id}`).row();
    }
    keyboard.text("◀️ Volver a Gestionar", "estrategias_manage");
    return { result, keyboard };
  }

  if (data.startsWith("estrategias_delete_pick_")) {
    const menuId = data.replace("estrategias_delete_pick_", "");
    const isOwnerUser = deps.getOwnerId() !== null && userId === deps.getOwnerId();
    const canProceed = isOwnerUser
      ? canDeleteCustomMenu(menuId, userId, true)
      : deps.getUserAssignedMenuIds(userId).includes(menuId);
    if (!canProceed) {
      result = isOwnerUser ? "No puedes eliminar esta estrategia." : "No tienes esta estrategia asignada.";
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar", "estrategias_manage");
      return { result, keyboard };
    }
    deletingMenuFlow.set(userId, { menuId });
    const label = deps.getExtraMenuLabel(menuId) ?? menuId;
    result = isOwnerUser
      ? `🗑 ¿Eliminar la estrategia *${escapeMd(label)}* (\`${menuId}\`)?\n\nSe quitará de todos los usuarios.`
      : `🗑 ¿Quitar la estrategia *${escapeMd(label)}* de tus asignadas?`;
    keyboard = new InlineKeyboard()
      .text("✅ Sí", `estrategias_delete_confirm_${menuId}`)
      .text("❌ No", "estrategias_delete_cancel")
      .row()
      .text("◀️ Volver a Gestionar", "estrategias_manage");
    return { result, keyboard };
  }

  if (data.startsWith("estrategias_delete_confirm_")) {
    const menuId = data.replace("estrategias_delete_confirm_", "");
    deletingMenuFlow.delete(userId);
    const isOwnerUser = deps.getOwnerId() !== null && userId === deps.getOwnerId();
    const canProceed = isOwnerUser
      ? canDeleteCustomMenu(menuId, userId, true)
      : deps.getUserAssignedMenuIds(userId).includes(menuId);
    if (!canProceed) {
      result = isOwnerUser ? "No puedes eliminar esta estrategia." : "No tienes esta estrategia asignada.";
      keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar", "estrategias_manage");
      return { result, keyboard };
    }
    const label = deps.getExtraMenuLabel(menuId) ?? menuId;
    if (isOwnerUser) {
      removeCustomMenu(menuId);
      unregisterExtraMenu(menuId);
      await removeMenuFromAllUsers(menuId);
      result = `✅ Estrategia *${escapeMd(label)}* eliminada del sistema.`;
    } else {
      await removeMenuFromUser(userId, menuId);
      result = `✅ Estrategia *${escapeMd(label)}* quitada de tus asignadas.`;
    }
    keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar", "estrategias_manage");
    return { result, keyboard };
  }

  if (data === "estrategias_delete_cancel") {
    deletingMenuFlow.delete(userId);
    result = "⚙️ *Gestionar estrategias*";
    keyboard = new InlineKeyboard()
      .text("📋 Listar estrategias", "estrategias_list")
      .row()
      .text("➕ Crear estrategia", "estrategias_create")
      .text("🗑 Eliminar estrategia", "estrategias_delete")
      .row()
      .text("◀️ Volver", "volver");
    return { result, keyboard };
  }

  return null;
}
