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
  getPendingPlan,
  getOwnerId,
  getOwnerIds,
  isOwner,
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
  loadLeadsFromSheet,
  getPlanTemporality,
  isPlanExpired,
} from "../user-config.js";
import {
  getPaymentMethods,
  getPaymentMethodById,
  deleteAndSavePaymentMethod,
  loadPaymentMethodsFromSheet,
} from "../payment-methods.js";
import {
  getExtraMenuIds,
  getExtraMenuLabel,
  getExtraMenuDescription,
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
  TEMPORALITIES,
  getPriceForTemporality,
  formatPlanPrice,
} from "../plans.js";
import {
  buildSecurityKeyboard,
  buildManageEstrategiasKeyboard,
  buildManagePlansKeyboard,
  buildUserMenusKeyboard,
  buildPlanMenusKeyboard,
  formatUserLine,
} from "./keyboards.js";
import { MAIN_MENU_MESSAGE } from "../menus/keyboards.js";
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

/** Límite de bytes de Telegram para callback_data. */
const TG_CB_MAX = 64;

/**
 * Construye un callback_data para el toggle de visibilidad garantizando ≤ 64 bytes.
 * Si el menuId es demasiado largo, se trunca (IDs existentes que superan el límite).
 */
function visToggleCb(prefix: string, menuId: string): string {
  const maxId = TG_CB_MAX - prefix.length;
  return prefix + (menuId.length > maxId ? menuId.slice(0, maxId) : menuId);
}

/**
 * Resuelve el menuId completo a partir del fragmento que llegó en el callback.
 * Maneja el caso en que el id fue truncado por el límite de 64 bytes de Telegram.
 */
function resolveMenuId(idFragment: string): string {
  const exact = getCustomMenus().find((m) => m.id === idFragment);
  if (exact) return exact.id;
  const byPrefix = getCustomMenus().find(
    (m) => idFragment.length < m.id.length && m.id.startsWith(idFragment)
  );
  return byPrefix?.id ?? idFragment;
}

/**
 * Resuelve un fragmento de menuId (posiblemente truncado) al id completo dentro de validIds.
 * Usado en admin_menu_add_ / admin_menu_remove_ donde el callback_data puede estar truncado.
 */
function resolveExtraMenuId(validIds: string[], idFragment: string): string {
  if (validIds.includes(idFragment)) return idFragment;
  const byPrefix = validIds.find(
    (id) => idFragment.length < id.length && id.startsWith(idFragment)
  );
  return byPrefix ?? idFragment;
}

/** Escapa caracteres especiales de Telegram Markdown (legacy) para evitar "can't parse entities". */
export function escapeMd(s: string): string {
  if (!s) return "";
  // En Markdown (legacy), los caracteres que suelen romper son: _, *, `, [
  // También escapamos ] y ( ) para mayor seguridad en descripciones largas.
  return s
    .replace(/\\/g, "\\\\")
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

export interface SecurityCallbackDeps {
  buildMainKeyboard: (userId: number | undefined) => InlineKeyboard;
  getExtraMenuIds: () => string[];
  getExtraMenuLabel: (menuId: string) => string | undefined;
  /** Si se proporciona, "Listar planes" recarga desde el Sheet antes de mostrar. */
  getStorageBackend?: () => "sheet" | "file";
  loadPlansFromSheet?: () => Promise<{ id: string; title: string; description: string; price: string; menuIds: string; price_1m: string; price_3m: string; price_6m: string; price_9m: string; price_1a: string; autoApprove: string }[]>;
  initPlansFromSheet?: (rows: { id: string; title: string; description: string; price: string; menuIds: string; price_1m: string; price_3m: string; price_6m: string; price_9m: string; price_1a: string; autoApprove: string }[]) => void;
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
    result =
      "⚙️ *Panel de Administración*\n\n" +
      "Centro de control completo del bot. Todo lo que puedes hacer desde aquí:\n\n" +
      "👥 *Usuarios* — Lista todos los usuarios con acceso, consulta su plan, estado y datos de contacto.\n\n" +
      "➕➖ *Acceso* — Agrega o elimina usuarios de la lista de acceso permitido.\n\n" +
      "📋 *Estrategias por usuario* — Asigna o quita estrategias individuales a cualquier usuario.\n\n" +
      "🤖 *Gestionar Estrategias* — Crea nuevas estrategias personalizadas, elimínalas, controla su visibilidad pública/privada y revisa las solicitudes de acceso pendientes.\n\n" +
      "💰 *Gestionar Planes* — Crea, edita y elimina planes de suscripción; asigna planes a usuarios; revisa y aprueba solicitudes de cambio de plan.";
    keyboard = buildSecurityKeyboard();
  } else if (data === "security_main") {
    clearAllFlows(ctx.from.id);
    result = MAIN_MENU_MESSAGE;
    keyboard = deps.buildMainKeyboard(ctx.from.id);
  } else if (data === "admin_list" || data.startsWith("admin_list_p:")) {
    await reloadConfigFromStorage();
    const PAGE_SIZE = 20;
    const page = data.startsWith("admin_list_p:")
      ? (parseInt(data.replace("admin_list_p:", ""), 10) || 0)
      : 0;
    const allowed = getAllowedUsers();
    const ownersList = getOwnerIds();
    const ownerIdsSet = new Set(ownersList);
    // Lista única de todos para mostrar: Dueños + Permitidos
    const list = Array.from(new Set([...ownersList, ...allowed]));
    
    let basicoCount = 0;
    let proCount = 0;
    list.forEach((uid) => {
      if (ownerIdsSet.has(uid)) return; // Los admins se cuentan aparte
      const rawPlan = getPlan(uid) || "";
      // Normalizar para quitar acentos y pasar a minúsculas
      const p = rawPlan.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      
      if (p.includes("pro")) proCount++;
      else if (p.includes("basico") || p.includes("trial")) basicoCount++;
    });
    const adminCount = ownerIdsSet.size;

    const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const slice = list.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE);
    const lines = slice.map((uid) => {
      const name = escapeMd((getUsername(uid) || "").trim() || "—");
      const phone = escapeMd((getPhone(uid) || "").trim() || "—");
      const plan = escapeMd((getPlan(uid) || "").trim() || "—");
      const status = escapeMd((getPlanStatus(uid) || "").trim() || "—");
      const pending = getPendingPlan(uid);
      const pendingNote = pending ? ` (→ ${escapeMd(pending)})` : "";
      const roleTag = ownerIdsSet.has(uid) ? " 👑 _Admin_" : "";
      return `• *ID:* \`${uid}\` | *Nombre:* ${name} | *Teléfono:* ${phone} | [📩 Contactar](tg://user?id=${uid})${roleTag}\n  *Plan:* ${plan}${pendingNote} | *Estado:* ${status}`;
    });
    const pageInfo = totalPages > 1 ? ` — pág. ${safePage + 1}/${totalPages}` : "";
    result =
      `👥 *Listar usuarios* (${list.length}) — 🥉Básico(${basicoCount}) 🥈Pro(${proCount}) 👑Admin(${adminCount})${pageInfo}\n\n` +
      "Toda la info del usuario. Usa *Agregar acceso* o *Quitar acceso* para gestionar.\n\n" +
      (lines.length ? lines.join("\n\n") : "_Ningún usuario con acceso_.");
    keyboard = new InlineKeyboard();
    // Paginación
    if (totalPages > 1) {
      if (safePage > 0) keyboard.text("◀️", `admin_list_p:${safePage - 1}`);
      keyboard.text(`${safePage + 1}/${totalPages}`, "noop_list_page");
      if (safePage < totalPages - 1) keyboard.text("▶️", `admin_list_p:${safePage + 1}`);
      keyboard.row();
    }
    keyboard.text("➕ Agregar acceso", "admin_add").row();
    keyboard.text("◀️ Volver a Administrar", "security_open");
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
    keyboard.text("◀️ Volver a Administrar", "security_open");
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
      keyboard.text("◀️ Volver a Administrar", "security_open");
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
    keyboard.text("◀️ Volver a Administrar", "security_open");
  } else if (/^admin_menus_\d+$/.test(data)) {
    const uid = parseInt(data.replace("admin_menus_", ""), 10);
    const requests = await getStrategyRequests();
    const userRequestedIds = requests.filter((r) => r.userId === uid).map((r) => r.menuId);
    keyboard = buildUserMenusKeyboard(uid, getExtraMenuIds, getExtraMenuLabel, userRequestedIds);
    const extra = getExtraMenus(uid);
    const ids = getExtraMenuIds();
    const menuList = ids
      .map((id) => `• ${getExtraMenuLabel(id) ?? id}${extra.includes(id) ? " ✓" : ""}`)
      .join("\n");
    result = `📋 *Menús para usuario* \`${uid}\`\n\nCada fila: ➕ dar acceso, ➖ quitar acceso.\n\n${menuList}`;
  } else if (data.startsWith("admin_menu_add_")) {
    const rest = data.replace("admin_menu_add_", "");
    const [uidStr, menuIdFragment] = rest.includes("|")
      ? rest.split("|")
      : [rest.split("_")[0], rest.split("_").slice(1).join("_")];
    const uid = parseInt(uidStr!, 10);
    const validIds = getExtraMenuIds();
    const menuId = resolveExtraMenuId(validIds, menuIdFragment ?? "");
    if (Number.isNaN(uid) || !validIds.includes(menuId)) {
      result = "Error.";
      keyboard = buildSecurityKeyboard();
    } else {
      const extra = getExtraMenus(uid);
      if (!extra.includes(menuId)) await toggleExtraMenu(uid, menuId);
      const requests = await getStrategyRequests();
      const userRequestedIds = requests.filter((r) => r.userId === uid).map((r) => r.menuId);
      keyboard = buildUserMenusKeyboard(uid, getExtraMenuIds, getExtraMenuLabel, userRequestedIds);
      const extraAfter = getExtraMenus(uid);
      const menuList = validIds
        .map((id) => `• ${getExtraMenuLabel(id) ?? id}${extraAfter.includes(id) ? " ✓" : ""}`)
        .join("\n");
      result = `📋 *Menús para usuario* \`${uid}\`\n\n✅ Acceso dado: ${getExtraMenuLabel(menuId) ?? menuId}\n\n${menuList}`;
    }
  } else if (data.startsWith("admin_menu_remove_")) {
    const rest = data.replace("admin_menu_remove_", "");
    const [uidStr, menuIdFragment] = rest.includes("|")
      ? rest.split("|")
      : [rest.split("_")[0], rest.split("_").slice(1).join("_")];
    const uid = parseInt(uidStr!, 10);
    const validIds = getExtraMenuIds();
    const menuId = resolveExtraMenuId(validIds, menuIdFragment ?? "");
    if (Number.isNaN(uid) || !validIds.includes(menuId)) {
      result = "Error.";
      keyboard = buildSecurityKeyboard();
    } else {
      const extra = getExtraMenus(uid);
      if (extra.includes(menuId)) await toggleExtraMenu(uid, menuId);
      const requests = await getStrategyRequests();
      const userRequestedIds = requests.filter((r) => r.userId === uid).map((r) => r.menuId);
      keyboard = buildUserMenusKeyboard(uid, getExtraMenuIds, getExtraMenuLabel, userRequestedIds);
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
    const userCountTag = (id: string): string => {
      const m = getCustomMenus().find((x) => x.id === id);
      const count = m?.subscribers ?? 0;
      return count > 0 ? ` 👤${count}` : "";
    };
    const lines = [
      ...builtIn.map((id) => `• ${getExtraMenuLabel(id) ?? id} (\`${id}\`) — _integrado_ — ${statusLabel(id)}`),
      ...custom.map((id) => `• ${getExtraMenuLabel(id) ?? id} (\`${id}\`) — ${statusLabel(id)}${userCountTag(id)}`),
    ];
    result =
      "📋 *Listar estrategias*\n\n" +
      (lines.length ? lines.join("\n") + "\n\n_✅ implementada_ = con función asignada · _⏳ pendiente_ = sin función (mensaje por defecto).\n_👤N_ = usuarios con la estrategia asignada (sin contar al creador)." : "_Ninguna_");
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
        const uName = (getUsername(r.userId) || r.userId.toString()).split(" ")[0] ?? "User";
        const sLabel = getExtraMenuLabel(r.menuId) ?? r.menuId;
        const shortName = uName.length > 10 ? uName.slice(0, 10) + "…" : uName;
        const shortStrat = sLabel.length > 15 ? sLabel.slice(0, 15) + "…" : sLabel;
        
        const menuFragment = r.menuId.length > 25 ? r.menuId.slice(0, 25) : r.menuId;
        const payload = `${r.userId}|${menuFragment}`;
        keyboard
          .text(`👤 ${shortName} - ${shortStrat}`, "noop")
          .text(`✅`, `admin_estrategias_approve_${payload}`)
          .text(`❌`, `admin_estrategias_reject_${payload}`)
          .row();
      }
      keyboard.text("◀️ Volver a Gestionar Estrategias", "admin_estrategias_manage");
    }
  } else if (data.startsWith("admin_estrategias_approve_")) {
    const rest = data.replace("admin_estrategias_approve_", "");
    const [uidStr, ...menuIdParts] = rest.split("|");
    const menuIdFragment = menuIdParts.join("|");
    const uid = parseInt(uidStr, 10);
    const validIds = getExtraMenuIds();
    const menuId = resolveExtraMenuId(validIds, menuIdFragment ?? "");
    if (Number.isNaN(uid) || !validIds.includes(menuId)) {
      result = "Solicitud no encontrada.";
      keyboard = buildManageEstrategiasKeyboard();
    } else {
      await approveStrategyRequest(uid, menuId);
      const label = getExtraMenuLabel(menuId) ?? menuId;
      result = `✅ Solicitud aprobada: usuario \`${uid}\` — *${escapeMd(label)}* (\`${menuId}\`).`;
      // Notificar al comprador
      ctx.api.sendMessage(uid,
        `🎉 *¡Tu solicitud fue aprobada!*\n\nYa tienes acceso a la estrategia *${escapeMd(label)}*. Ve a tu menú de estrategias para usarla.`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      keyboard = new InlineKeyboard().text("◀️ Volver a Solicitudes", "admin_estrategias_requests");
    }
  } else if (data.startsWith("admin_estrategias_reject_")) {
    const rest = data.replace("admin_estrategias_reject_", "");
    const [uidStr, ...menuIdParts] = rest.split("|");
    const menuIdFragment = menuIdParts.join("|");
    const uid = parseInt(uidStr, 10);
    const validIds = getExtraMenuIds();
    const menuId = resolveExtraMenuId(validIds, menuIdFragment ?? "");
    if (Number.isNaN(uid) || !validIds.includes(menuId)) {
      result = "Solicitud no encontrada.";
      keyboard = buildManageEstrategiasKeyboard();
    } else {
      await removeStrategyRequest(uid, menuId);
      const label = getExtraMenuLabel(menuId) ?? menuId;
      result = `❌ Solicitud rechazada: usuario \`${uid}\` — *${escapeMd(label)}*.`;
      // Notificar al comprador
      ctx.api.sendMessage(uid,
        `❌ *Tu solicitud fue rechazada*\n\nEl administrador no aprobó el acceso a *${escapeMd(label)}*. Puedes contactarlo para más información.`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
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
        keyboard.text(`${next}: ${m.label}`, visToggleCb("admin_estrategias_visibility_toggle_", m.id)).row();
      }
      keyboard.text("◀️ Volver a Gestionar Estrategias", "admin_estrategias_manage");
    }
  } else if (data.startsWith("admin_estrategias_visibility_toggle_")) {
    const menuId = resolveMenuId(data.replace("admin_estrategias_visibility_toggle_", ""));
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
  } else if (data.startsWith("admin_assign_plan_") && !data.startsWith("admin_assign_plan_cancel") && !data.startsWith("admin_assign_plan_temp_")) {
    const planId = data.replace("admin_assign_plan_", "");
    const plan = getPlanById(planId);
    const flow = assigningPlanFlow.get(ctx.from.id);
    if (!plan || !flow || flow.step !== 2) {
      result = plan ? "Sesión expirada. Vuelve a *Asignar plan a usuario* e introduce el ID." : "Plan no encontrado.";
      keyboard = buildManagePlansKeyboard();
      if (flow) assigningPlanFlow.delete(ctx.from.id);
    } else {
      // Paso 3: pedir temporalidad
      assigningPlanFlow.set(ctx.from.id, { step: 3, targetUserId: flow.targetUserId, planId });
      result = `👤 *Asignar plan: ${escapeMd(plan.title)}*\n\nElige la duración (temporalidad) para el usuario \`${flow.targetUserId}\`:`;
      keyboard = new InlineKeyboard();
      for (const t of TEMPORALITIES) {
        const price = getPriceForTemporality(plan, t.id);
        const priceLabel = price ? ` — ${formatPlanPrice(price)}` : "";
        keyboard.text(`${t.label}${priceLabel}`, `admin_assign_plan_temp_${planId}_${t.id}`).row();
      }
      keyboard.text("◀️ Cancelar", "admin_assign_plan_cancel");
    }
  } else if (data.startsWith("admin_assign_plan_temp_")) {
    const rest = data.slice("admin_assign_plan_temp_".length);
    const lastUnderscore = rest.lastIndexOf("_");
    const planId = lastUnderscore > 0 ? rest.slice(0, lastUnderscore) : rest;
    const temporality = lastUnderscore > 0 ? rest.slice(lastUnderscore + 1) : "";
    const plan = getPlanById(planId);
    const flow = assigningPlanFlow.get(ctx.from.id);
    if (!plan || !flow || flow.step !== 3 || !TEMPORALITIES.some((t) => t.id === temporality)) {
      result = "Sesión expirada o temporalidad inválida. Vuelve a *Asignar plan a usuario*.";
      keyboard = buildManagePlansKeyboard();
      if (flow) assigningPlanFlow.delete(ctx.from.id);
    } else {
      const targetUserId = flow.targetUserId;
      assigningPlanFlow.delete(ctx.from.id);
      const assignResult = await assignPlanToUser(targetUserId, plan.title, plan.menuIds ?? [], temporality);
      const tLabel = TEMPORALITIES.find((t) => t.id === temporality)?.label ?? temporality;
      if (assignResult.ok) {
        result = `✅ Plan *${escapeMd(plan.title)}* (${tLabel}) asignado al usuario \`${targetUserId}\`.`;
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
      const prices = TEMPORALITIES
        .map((t) => { const pr = getPriceForTemporality(p, t.id); return pr ? `${t.label}: *${escapeMd(formatPlanPrice(pr))}*` : null; })
        .filter(Boolean).join(" · ");
      const autoTag = p.autoApprove ? " _(auto-aprobado)_" : "";
      return `• *${escapeMd(p.title)}*${autoTag}${prices ? `\n  ${prices}` : ""}\n  ${escapeMd(p.description.slice(0, 50))}${p.description.length > 50 ? "…" : ""}\n  Menús: \`${menus}\``;
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
        const pLabel = p.price ? ` (${formatPlanPrice(p.price)})` : "";
        keyboard.text(`✏️ ${p.title}${pLabel}`, `admin_plans_edit_pick_${p.id}`).row();
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
      const pLabel = plan.price ? ` (${formatPlanPrice(plan.price)})` : "";
      result = `🗑 ¿Eliminar el plan *${plan.title}*${pLabel}?`;
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
        "📩 *Solicitudes pendientes*\n\nNo hay solicitudes. Cuando un usuario sin acceso elija un plan, o un usuario con acceso solicite cambiar de plan, aparecerán aquí.";
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
        const typeTag = u.isPlanChange ? " _🔄 cambio de plan_" : " _🆕 acceso nuevo_";
        const tLabel = u.temporality ? ` (${TEMPORALITIES.find((t) => t.id === u.temporality)?.label ?? u.temporality})` : "";
        return `• *ID:* \`${id}\` | *Plan:* ${plan}${tLabel}${typeTag}\n  *Nombre:* ${nombre} | *Teléfono:* ${telefono}`;
      });
      result =
        "📩 *Solicitudes pendientes*\n\n_🆕 acceso nuevo_ = usuario sin acceso · _🔄 cambio de plan_ = usuario activo cambiando plan\n\n" +
        lines.join("\n\n");
      keyboard = new InlineKeyboard();
      for (const u of requested) {
        const displayName = (u.name && u.name.trim()) ? u.name.trim() : null;
        const typeIcon = u.isPlanChange ? "🔄" : "✅";
        const tLabel = u.temporality ? ` ${TEMPORALITIES.find((t) => t.id === u.temporality)?.label ?? u.temporality}` : "";
        const label = displayName
          ? `${typeIcon} ${u.userId} — ${u.plan}${tLabel} (${displayName})`
          : `${typeIcon} Aprobar ${u.userId} (${u.plan}${tLabel})`;
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
      const isPlanChange = requested?.isPlanChange ?? false;
      const approveResult = await approvePlanRequest(userId, planMenuIds);
      if (approveResult.ok) {
        const menuInfo = planMenuIds.length > 0 ? ` Menús del plan: ${planMenuIds.join(", ")}.` : "";
        const tLabel = requested?.temporality
          ? ` (${TEMPORALITIES.find((t) => t.id === requested.temporality)?.label ?? requested.temporality})`
          : "";
        result = isPlanChange
          ? `✅ *Cambio de plan aprobado*\n\nUsuario \`${userId}\` tiene ahora el plan *${escapeMd(requested?.plan ?? "")}*${tLabel}.${menuInfo}`
          : `✅ *Solicitud aprobada*\n\nUsuario \`${userId}\` tiene acceso al plan *${escapeMd(requested?.plan ?? "")}*${tLabel}.${menuInfo}`;
        // Notificar al solicitante
        const planLabel = escapeMd(requested?.plan ?? "");
        const tLabelClean = requested?.temporality
          ? ` (${TEMPORALITIES.find((t) => t.id === requested.temporality)?.label ?? requested.temporality})`
          : "";
        ctx.api.sendMessage(userId,
          `🎉 *¡Tu acceso fue aprobado!*\n\nYa tienes acceso activo al plan *${planLabel}*${tLabelClean}. ¡Bienvenido! Usa /start para entrar al bot.`,
          { parse_mode: "Markdown" }
        ).catch(() => {});
      } else {
        result = `❌ *Error al aprobar*\n\n${approveResult.error ?? "No se pudo procesar la solicitud."}\n\nRevisa las solicitudes pendientes.`;
      }
      keyboard = new InlineKeyboard().text("📋 Ver Solicitudes Pendientes", "admin_plans_requests").row().text("◀️ Gestionar Planes", "admin_plans_manage");
    }
  } else if (data.startsWith("admin_plans_reject_")) {
    const userIdStr = data.replace("admin_plans_reject_", "");
    const userId = parseInt(userIdStr, 10);
    if (Number.isNaN(userId)) {
      result = "ID de usuario inválido.";
      keyboard = buildManagePlansKeyboard();
    } else {
      const requested = getRequestedPlanUsers().find((u) => u.userId === userId);
      const planLabel = escapeMd(requested?.plan ?? "plan solicitado");
      // Eliminar la solicitud del estado pendiente
      await approvePlanRequest(userId, []).catch(() => {}); // ensures the pending row is cleared
      result = `❌ *Solicitud rechazada*\n\nSolicitud de \`${userId}\` para el plan *${planLabel}* fue rechazada.`;
      // Notificar al solicitante
      ctx.api.sendMessage(userId,
        `❌ *Tu solicitud de plan fue rechazada*\n\nEl administrador no aprobó el acceso al plan *${planLabel}*. Puedes contactarlo para más información.`,
        { parse_mode: "Markdown" }
      ).catch(() => {});
      keyboard = new InlineKeyboard().text("💻 Ver Solicitudes Pendientes", "admin_plans_requests").row().text("◀️ Gestionar Planes", "admin_plans_manage");
    }
  } else if (data === "admin_leads" || data === "admin_leads_refresh") {
    const todosLosLeads = await loadLeadsFromSheet();
    const pendientes = getRequestedPlanUsers();

    // Filtramos leads para NO mostrar a los que ya son clientes convertidos activos
    const leadsFiltrados = todosLosLeads.filter(l => {
      const uid = Number(l.userId);
      if (Number.isNaN(uid)) return true;

      const isPending = pendientes.some(u => u.userId === uid);
      if (isPending) {
        l.status = "pendiente";
        return true;
      }

      const planActual = getPlan(uid);
      if (planActual) {
        if (isPlanExpired(uid)) {
          l.status = "lost";
          return true;
        }
        const temp = getPlanTemporality(uid);
        if (temp === "1d" || temp === "1 h") {
          l.status = "trial_active";
          return true;
        }
        // Están en un plan pagado válido (no trial, no expirado)
        l.status = "converted";
        return false; // NO MOSTRAR Convertidos en Leads
      }

      // Sin plan activo ni pendiente = lost (trial expirado sin renovar)
      l.status = "lost";
      return true;
    });

    if (leadsFiltrados.length === 0) {
      result = "📊 *Leads Activos/Perdidos*\n\n_No hay leads pendientes, perdidos o en trial actualmente._";
      keyboard = new InlineKeyboard()
        .text("🔄 Actualizar", "admin_leads_refresh")
        .row()
        .text("◀️ Volver a Administrar", "security_open");
    } else {
      const recent = leadsFiltrados.slice(-30).reverse();
      const lines = recent.map((l) => {
        const nombre = escapeMd((l.nombre && l.nombre.trim()) ? l.nombre.trim() : "—");
        const telefono = escapeMd((l.telefono && l.telefono.trim()) ? l.telefono.trim() : "—");
        const plan = escapeMd(l.plan || "—");
        const fecha = escapeMd(l.fecha || "—");
        const status = l.status || "—";
        const statusIcon = status === "trial_active" ? "🟢" : status === "lost" ? "🔴" : "⏳";
        return `• *ID:* \`${l.userId}\` | ${nombre}\n  📞 ${telefono} | 📋 ${plan} | ${statusIcon} ${escapeMd(status)}\n  📅 ${fecha}`;
      });
      result =
        `📊 *Leads* (${leadsFiltrados.length} listados, últimos ${recent.length})\n\n` +
        "🟢 trial\\_active · ⏳ pendiente · 🔴 lost\n" +
        "_Nota: Los leads que ya convirtieron a pago no se muestran aquí._\n\n" +
        lines.join("\n\n");
      keyboard = new InlineKeyboard()
        .text("🔄 Actualizar", "admin_leads_refresh")
        .row()
        .text("◀️ Volver a Administrar", "security_open");
    }
  } else if (data === "admin_pm_open" || data === "admin_pm_refresh") {
    await loadPaymentMethodsFromSheet();
    const pms = getPaymentMethods();
    const pmLines = pms.map((p, i) =>
      `${i + 1}. *${escapeMd(p.description)}*\n   💳 ${escapeMd(p.account)} · 🌐 ${escapeMd(p.currency)}`
    );
    result =
      `💳 *Formas de pago* (${pms.length})\n\n` +
      (pmLines.length ? pmLines.join("\n\n") : "_Sin formas de pago configuradas._");
    keyboard = new InlineKeyboard();
    for (const pm of pms) {
      const short = pm.description.length > 28 ? pm.description.slice(0, 26) + "…" : pm.description;
      keyboard
        .text(`✏️ ${short}`, `admin_pm_edit:${pm.id}`)
        .copyText(`📋 ${pm.account}`, pm.account)
        .text("🗑", `admin_pm_del:${pm.id}`)
        .row();
    }
    keyboard.text("➕ Nueva forma de pago", "admin_pm_new").row().text("◀️ Volver a Administrar", "security_open");
  } else if (data === "admin_pm_new") {
    result =
      "💳 *Nueva forma de pago* (paso 1/3)\n\n" +
      "Envía la *descripción* (ej: Zelle, PayPal, Transferencia).\n\n/cancel para cancelar.";
    keyboard = new InlineKeyboard().text("◀️ Cancelar", "admin_pm_open");
    const { creatingPaymentMethodFlow } = await import("./flows.js");
    creatingPaymentMethodFlow.set(ctx.from.id, { step: 1 });
  } else if (data.startsWith("admin_pm_edit:")) {
    const pmId = data.slice("admin_pm_edit:".length);
    const pm = getPaymentMethodById(pmId);
    if (!pm) {
      result = "❌ Forma de pago no encontrada.";
      keyboard = new InlineKeyboard().text("◀️ Volver", "admin_pm_open");
    } else {
      result =
        `✏️ *Editar forma de pago* (paso 1/3)\n\nActual: *${escapeMd(pm.description)}* | ${escapeMd(pm.account)} | ${escapeMd(pm.currency)}\n\nEnvía la nueva *descripción* (o *-* para mantener).\n\n/cancel para cancelar.`;
      keyboard = new InlineKeyboard().text("◀️ Cancelar", "admin_pm_open");
      const { editingPaymentMethodFlow } = await import("./flows.js");
      editingPaymentMethodFlow.set(ctx.from.id, { step: 1, id: pmId });
    }
  } else if (data.startsWith("admin_pm_del:")) {
    const pmId = data.slice("admin_pm_del:".length);
    const pm = getPaymentMethodById(pmId);
    if (!pm) {
      result = "❌ Forma de pago no encontrada.";
      keyboard = new InlineKeyboard().text("◀️ Volver", "admin_pm_open");
    } else {
      result = `🗑 *Eliminar forma de pago*\n\n${escapeMd(pm.description)} (${escapeMd(pm.account)})\n\n¿Confirmas?`;
      keyboard = new InlineKeyboard()
        .text("✅ Sí, eliminar", `admin_pm_del_confirm:${pmId}`)
        .text("❌ Cancelar", "admin_pm_open");
    }
  } else if (data.startsWith("admin_pm_del_confirm:")) {
    const pmId = data.slice("admin_pm_del_confirm:".length);
    const pm = getPaymentMethodById(pmId);
    const ok = await deleteAndSavePaymentMethod(pmId);
    const pmsAfter = getPaymentMethods();
    const linesAfter = pmsAfter.map((p, i) => `${i + 1}. *${escapeMd(p.description)}* | ${escapeMd(p.account)} · ${escapeMd(p.currency)}`);
    result = (ok ? `✅ *${escapeMd(pm?.description ?? pmId)}* eliminada.` : "❌ No encontrada.") +
      `\n\n💳 *Formas de pago* (${pmsAfter.length})\n\n` +
      (linesAfter.length ? linesAfter.join("\n") : "_Sin formas de pago._");
    keyboard = new InlineKeyboard().text("➕ Nueva", "admin_pm_new").row().text("◀️ Volver a Administrar", "security_open");
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
  isOwner: (userId: number) => boolean;
  buildMainKeyboard: (userId: number | undefined) => InlineKeyboard;
  /**
   * Si se provee, se llama antes de mostrar la Tienda para garantizar que la
   * visibilidad de las estrategias esté sincronizada con el Sheet.
   */
  reloadStrategies?: () => Promise<void>;
  hasPreviewedStrategy: (userId: number, menuId: string) => boolean;
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
    // Solo los Pro y el dueño pueden gestionar visibilidad
    const isOwnerUser = deps.isOwner(userId);
    const userPlanForVis = getPlan(userId) ?? "";
    const isProUser = isOwnerUser || userPlanForVis.toLowerCase().includes("pro");
    if (!isProUser) {
      result += "\n\n💡 _Para publicar tus estrategias en la tienda debes moverte al plan Pro._";
      keyboard.text("🌐 Visibilidad (pública/privada)", "estrategias_visibility").row();
      keyboard.text("◀️ Volver", "volver").row().text("⬆️ Cambiar Plan", "cambiar_plan_open");
    } else {
      keyboard.text("🌐 Visibilidad (pública/privada)", "estrategias_visibility").row();
      keyboard.text("◀️ Volver", "volver");
    }
    return { result, keyboard };
  }

  if (data === "estrategias_tienda") {
    // Sincronizar visibilidad desde el Sheet antes de mostrar la Tienda
    await deps.reloadStrategies?.();

    // Estrategias ya accesibles: las del plan + las asignadas explícitamente
    const myIds = new Set(deps.getExtraMenus(userId));

    const isOwnerUser = deps.isOwner(userId);
    const publicList = getPublicStrategies().filter(
      (m) =>
        // No mostrar las que ya tienes (plan o asignadas)
        !myIds.has(m.id) &&
        // No mostrar las que creaste tú mismo (no tendría sentido comprarlas)
        m.createdBy !== userId &&
        // El dueño no compra por la Tienda; gestiona directamente desde el panel
        !isOwnerUser
    );
    if (publicList.length === 0) {
      result = "🛒 *Tienda*\n\n_No hay estrategias públicas disponibles en este momento o ya tienes acceso a todas._";
      keyboard = new InlineKeyboard().text("◀️ Volver", "volver");
      return { result, keyboard };
    }
    result = "🛒 *Tienda*\n\nEstrategias públicas que puedes solicitar. Solo el administrador puede aprobar tu solicitud.\n\n";
    for (const m of publicList) {
      const priceStr = m.price ? ` — ${escapeMd(m.price)}` : "";
      result += `• ${escapeMd(m.label)} (\`${m.id}\`)${priceStr}\n`;
    }
    keyboard = new InlineKeyboard();
    for (const m of publicList) {
      keyboard.text(`🛒 Comprar: ${m.label}`, `estrategias_request_${m.id}`).row();
    }
    keyboard.text("◀️ Volver", "volver");
    return { result, keyboard };
  }

  if (data.startsWith("estrategias_request_")) {
    const menuId = data.replace("estrategias_request_", "");
    if (!isCustomMenu(menuId) || getMenuVisibility(menuId) !== "public") {
      result = "Estrategia no disponible.";
      keyboard = new InlineKeyboard().text("◀️ Volver a Tienda", "estrategias_tienda");
      return { result, keyboard };
    }

    const label = deps.getExtraMenuLabel(menuId) ?? menuId;
    const desc = getExtraMenuDescription(menuId) || "Sin descripción disponible.";
    const price = getMenuPrice(menuId) || "10";

    result = `🛒 *Detalles de la Estrategia*\n\n` +
             `*Nombre:* ${escapeMd(label)}\n` +
             `*Precio:* ${escapeMd(price)}\n\n` +
             `*Descripción:* \n${escapeMd(desc)}\n\n`;

    const createdBy = (userId !== undefined) ? deps.getMenuCreatedBy?.(menuId) : undefined;
    const hasAccess = (userId !== undefined) && (deps.getExtraMenus(userId).includes(menuId) || createdBy === userId || deps.isOwner(userId));

    // Verificar si tiene plan Pro (dueños siempre pasan)
    const userPlan = userId !== undefined ? getPlan(userId) ?? "" : "";
    const isProPlan = deps.isOwner(userId ?? 0) || userPlan.toLowerCase().includes("pro");

    keyboard = new InlineKeyboard();
    if (!isProPlan) {
      // Plan Básico: mostrar aviso de upgrade y solo botón de volver
      result += "⚠️ _Debes adquirir un plan Pro para poder comercializar estrategias._";
    } else if (hasAccess) {
      result += "✅ *Ya tienes acceso a esta estrategia.*";
    } else {
      result += "¿Deseas enviar la solicitud de acceso?";
      keyboard.text("✅ Enviar Solicitud", `estrategias_confirm_request_${menuId}`).row();

      // Vista previa solo para estrategias con runner y si no la ha probado aún
      if (userId !== undefined && !deps.hasPreviewedStrategy(userId, menuId)) {
        keyboard.text("🎰 Ver Previa (Cálculo)", `strat_store_preview_${menuId}`).row();
      }
    }

    keyboard.text("◀️ Volver a Tienda", "estrategias_tienda");
    if (!isProPlan) {
      keyboard.row().text("⬆️ Cambiar Plan", "cambiar_plan_open");
    }
    return { result, keyboard };
  }

  if (data.startsWith("estrategias_confirm_request_")) {
    const menuId = data.replace("estrategias_confirm_request_", "");
    const added = await addStrategyRequest(userId, menuId);
    const label = deps.getExtraMenuLabel(menuId) ?? menuId;
    
    if (added) {
      // Notificar al admin
      const adminId = getOwnerId();
      if (adminId && adminId !== userId) {
        const username = ctx.from?.username ? `@${ctx.from.username}` : (ctx.from?.first_name || String(userId));
        const adminMsg = `🔔 *Nueva solicitud de estrategia*\n\nUsuario: ${escapeMd(username)} (\`${userId}\`)\nEstrategia: *${escapeMd(label)}* (\`${menuId}\`)`;
        const menuFragment = menuId.length > 25 ? menuId.slice(0, 25) : menuId;
        const payload = `${userId}|${menuFragment}`;
        const adminKb = new InlineKeyboard()
          .text("✅ Aprobar", `admin_estrategias_approve_${payload}`)
          .text("❌ Rechazar", `admin_estrategias_reject_${payload}`)
          .row()
          .url("📩 Contactar Usuario", `tg://user?id=${userId}`);
        // Notificar a todos los owners
        for (const oid of getOwnerIds().filter((id) => id !== userId)) {
          ctx.api.sendMessage(oid, adminMsg, { parse_mode: "Markdown", reply_markup: adminKb }).catch(() => {});
        }
      }
    }

    const adminIdForContact = getOwnerId();
    const contactMsg = adminIdForContact ? `\n\n[📩 Contactar al administrador](tg://user?id=${adminIdForContact})` : "";

    result = added
      ? `✅ Solicitud enviada: *${escapeMd(label)}* (\`${menuId}\`). El administrador la revisará.${contactMsg}`
      : `Ya tenías una solicitud pendiente para esta estrategia.${contactMsg}`;
    keyboard = new InlineKeyboard().text("◀️ Volver a Tienda", "estrategias_tienda");

    if (added) {
      // Mostrar formas de pago disponibles en un mensaje separado
      try {
        await loadPaymentMethodsFromSheet();
        const pms = getPaymentMethods();
        if (pms.length > 0) {
          const pmLines = pms.map((p, i) =>
            `${i + 1}. *${p.description}*\n   💳 \`${p.account}\` · 🌐 ${p.currency}`
          );
          const pmText = `💳 *Formas de pago disponibles:*\n\n` + pmLines.join("\n\n");
          const pmKb = new InlineKeyboard();
          for (const pm of pms) {
            pmKb.copyText(`📋 ${pm.description}`, pm.account).row();
          }
          // Usamos sendMessage porque este handler solo devuelve result/keyboard para editMessageText superior
          ctx.api.sendMessage(userId, pmText, { parse_mode: "Markdown", reply_markup: pmKb }).catch(() => {});
        }
      } catch (pmErr) {
        console.error("[estrategias_confirm_request] Error mostrando formas de pago:", pmErr);
      }
    }

    return { result, keyboard };
  }

  if (data === "estrategias_visibility") {
    const isOwnerUser = deps.isOwner(userId);
    const userPlanForVis = getPlan(userId) ?? "";
    const isProUser = isOwnerUser || userPlanForVis.toLowerCase().includes("pro");

    if (!isProUser) {
      result = "🌐 *Visibilidad (pública/privada)*\n\n⚠️ Solo los usuarios con *Plan Pro* pueden publicar sus estrategias en la tienda y hacerlas visibles a otros usuarios.\n\nActualiza tu plan para desbloquear esta funcionalidad.";
      keyboard = new InlineKeyboard()
        .text("◀️ Volver a Gestionar", "estrategias_manage").row()
        .text("⬆️ Cambiar Plan", "cambiar_plan_open");
      return { result, keyboard };
    }

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
      keyboard.text(`${next}: ${m.label}`, visToggleCb("estrategias_visibility_toggle_", m.id)).row();
    }
    keyboard.text("◀️ Volver a Gestionar", "estrategias_manage");
    return { result, keyboard };
  }

  if (data.startsWith("estrategias_visibility_toggle_")) {
    const menuId = resolveMenuId(data.replace("estrategias_visibility_toggle_", ""));
    const isOwnerUser = deps.isOwner(userId);
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
    const isOwnerUser = deps.isOwner(userId);
    const getIcon = (menuId: string): string => {
      const createdBy = deps.getMenuCreatedBy?.(menuId);
      if (isOwnerUser) {
        if (createdBy === undefined || createdBy === 0 || deps.isOwner(createdBy)) return "👤 ";
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
      let countTag = "";
      if (isCustomMenu(id)) {
        const m = getCustomMenus().find((x) => x.id === id);
        const count = m?.subscribers ?? 0;
        if (count > 0) countTag = ` 👤${count}`;
      }
      lines.push(`• ${icon}${escapeMd(label)} (\`${id}\`)${suffix}${countTag}`);
    }
    const legend = isOwnerUser
      ? "\n\n_Leyenda: 👤 propia · 👥 creada por un usuario · 👤N = usuarios con la estrategia_"
      : "\n\n_Leyenda: 📋 plan · ➕ adquirida · ✏️ propia_";
    result =
      "*Tus estrategias*" +
      "\n\n" +
      (lines.length ? lines.join("\n") + legend : "_Ninguna asignada ni creada por ti._");
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
    const isOwnerUser = deps.isOwner(userId);
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
    const isOwnerUser = deps.isOwner(userId);
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
    const isOwnerUser = deps.isOwner(userId);
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
