/**
 * Bot de Telegram: Florida Lottery Pick 3 y Pick 4 — resultados desde los PDF oficiales.
 * Fuentes: p3.pdf y p4.pdf. Menú: Hoy, Ayer, Esta Semana, Fecha específica (☀️ Mediodía / 🌙 Noche).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Bot, InlineKeyboard } from "grammy";
import type { Update } from "grammy/types";
import {
  getOwnerId,
  isAllowed,
  getExtraMenus,
  addAllowed,
  removeAllowed,
  toggleExtraMenu,
  getAllowedUsers,
  getUsername,
  getPhone,
  setUserInfo,
  isOwner,
  initUserConfig,
  removeMenuFromAllUsers,
} from "./user-config.js";
import {
  registerExtraMenu,
  unregisterExtraMenu,
  updateExtraMenuLabel,
  getExtraMenuIds,
  getExtraMenuLabel,
  getHandler,
  EXTRA_MENU_CALLBACK_PREFIX,
} from "./menu-registry.js";
import {
  initCustomMenus,
  getCustomMenus,
  isCustomMenu,
  addCustomMenu,
  updateCustomMenu,
  removeCustomMenu,
} from "./custom-menus.js";
import {
  buildGroupStatsMessage as buildGroupStatsMessageFromStats,
  buildIndividualTop10Message as buildIndividualTop10MessageFromStats,
} from "./stats-p3.js";

/** Menús integrados en código; no se pueden eliminar desde el bot. */
const BUILTIN_MENU_IDS = new Set(["est_grupos", "est_individuales"]);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL ?? "";
const FLORIDA_TZ = "America/New_York";

/** Enlace al chat/grupo donde los usuarios pueden solicitar acceso (ej: t.me/mi_grupo o https://t.me/...). Si está definido, se muestra en el mensaje a no autorizados. */
const REQUEST_ACCESS_LINK = process.env.REQUEST_ACCESS_LINK?.trim() ?? "";

const HELP_TEXT =
  "🏝 *Florida Lottery — Fijo y Corrido*\n\n" +
  "☀️ *Mediodía (M)* · 🌙 *Noche (E)*\n\n" +
  "Elige *Fijo* (P3), *Corrido* (P4) o *Ambos*; luego Hoy, Ayer, Esta semana o una fecha.";

type GameMenu = "fijo" | "corrido" | "ambos";

/** Menú: default (Fijo, Corrido, Ambos) + menús extra asignados (registry) + Ayuda. Dueño ve todos los extra y Seguridad. */
function buildMainKeyboard(userId: number | undefined): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("🎯 Fijo (P3)", "menu_fijo")
    .text("🎲 Corrido (P4)", "menu_corrido")
    .row()
    .text("☀️🌙 Ambos (Fijo + Corrido)", "menu_ambos");
  const ownerId = getOwnerId();
  const extraIds = getExtraMenuIds();
  const showExtra = extraIds.filter((id) => {
    if (ownerId === null) return true;
    if (userId === ownerId) return true;
    return getExtraMenus(userId ?? 0).includes(id);
  });
  if (showExtra.length > 0) {
    kb.row();
    for (const id of showExtra) {
      const label = getExtraMenuLabel(id);
      if (label) kb.text(label, EXTRA_MENU_CALLBACK_PREFIX + id);
    }
  }
  kb.row().text("❓ Ayuda", "help");
  if (ownerId !== null && userId === ownerId) {
    kb.row().text("🔒 Seguridad", "security_open");
  }
  return kb;
}

function buildSubmenuKeyboard(game: GameMenu): InlineKeyboard {
  const prefix = game === "fijo" ? "fijo" : game === "corrido" ? "corrido" : "ambos";
  return new InlineKeyboard()
    .text("☀️🌙 Hoy", `${prefix}_hoy`)
    .text("☀️🌙 Ayer", `${prefix}_ayer`)
    .row()
    .text("📆 Esta semana", `${prefix}_semana`)
    .row()
    .text("📅 Escoger fecha", `${prefix}_fecha`)
    .row()
    .text("◀️ Volver", "volver");
}

/** Días de diferencia por defecto para marcar Hot: (Máx.hist - Máx.actual) ≤ este valor. */
let hotThresholdDays = 5;

function buildEstadisticasKeyboard(threshold: number = hotThresholdDays): InlineKeyboard {
  return new InlineKeyboard()
    .text("☀️ Mediodía (M)", "stats_grupos_M")
    .text("🌙 Noche (E)", "stats_grupos_E")
    .row()
    .text(`🔢 Días diferencia: ${threshold}`, "stats_set_days")
    .row()
    .text("◀️ Volver", "volver");
}

function buildIndividualPeriodKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("☀️ Mediodía (M)", "stats_individual_M")
    .text("🌙 Noche (E)", "stats_individual_E")
    .row()
    .text("◀️ Volver", "volver");
}

function buildDiasDiferenciaKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("1", "stats_days_1")
    .text("3", "stats_days_3")
    .text("5", "stats_days_5")
    .text("7", "stats_days_7")
    .text("10", "stats_days_10")
    .row()
    .text("◀️ Volver", "volver");
}

/** Handler para menús creados por el dueño que aún no tienen lógica en código. */
function placeholderMenuHandler(ctx: { answerCallbackQuery: () => Promise<unknown>; editMessageText: (text: string, opts?: object) => Promise<unknown>; from?: { id: number } }): Promise<void> {
  return (async () => {
    await ctx.answerCallbackQuery();
    try {
      await ctx.editMessageText("🚧 Esta función está en desarrollo.", {
        parse_mode: "Markdown",
        reply_markup: buildMainKeyboard(ctx.from?.id),
      });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
  })();
}

/** Registro de menús extra (asignables por usuario). Agregar aquí nuevos menús y su handler. */
function registerExtraMenus(): void {
  registerExtraMenu("est_grupos", "📊 Est. grupos", async (ctx) => {
    await ctx.answerCallbackQuery();
    const result =
      "📊 *Estadísticas por grupos* (Fijo P3)\n\nElige *Mediodía (M)* o *Noche (E)*. Grupos: terminales (0-9), iniciales (0-9), dobles.\n\n🔥 Hot = (Máx.hist − Máx.actual) ≤ Días diferencia.";
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: buildEstadisticasKeyboard() });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
  });
  registerExtraMenu("est_individuales", "📈 Est. individuales", async (ctx) => {
    await ctx.answerCallbackQuery();
    const result = "📈 *Top 10 más Hot* (números 00-99)\n\nElige *Mediodía (M)* o *Noche (E)* para ver las estadísticas.";
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: buildIndividualPeriodKeyboard() });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
  });
}

const bot = new Bot(BOT_TOKEN);

/** Si BOT_OWNER_ID está definido, solo el dueño y usuarios en la whitelist pueden usar el bot. */
bot.use(async (ctx, next) => {
  const uid = ctx.from?.id;
  if (uid === undefined) return next();
  const ownerId = getOwnerId();
  if (ownerId === null) return next();
  if (isAllowed(uid)) return next();
  const raw = REQUEST_ACCESS_LINK;
  let link = "";
  if (raw) {
    link = raw.startsWith("http") ? raw : "https://t.me/" + raw.replace(/^t\.me\/?/i, "");
  } else if (ownerId !== null) {
    link = `tg://user?id=${ownerId}`;
  }
  const msg =
    "🔒 *Este bot es de uso restringido.*\n\n" +
    "Para solicitar acceso, contacta al administrador y envíale tu ID.\n\n" +
    `Tu ID de Telegram: \`${uid}\` — cópialo y envíalo al dueño del bot.\n\n` +
    (link
      ? "👇 Toca el botón para abrir un chat directo con el administrador y solicitar acceso:"
      : "_No se pudo generar el enlace de contacto._");
  const keyboard = link ? new InlineKeyboard().url("📩 Chatear con el dueño del bot", link) : undefined;
  await ctx.reply(msg, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
  return;
});

bot.command("start", async (ctx) => {
  const userId = ctx.from?.id;
  await ctx.reply(
    "👋 Resultados *Fijo* (P3) y *Corrido* (P4) de Florida Lottery.\n\nElige juego y luego el período:",
    {
      parse_mode: "Markdown",
      reply_markup: buildMainKeyboard(userId),
    }
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(HELP_TEXT, {
    parse_mode: "Markdown",
    reply_markup: buildMainKeyboard(ctx.from?.id),
  });
});

/** Usuario esperando escribir fecha → juego elegido (fijo, corrido o ambos). */
const waitingCustomDateGame = new Map<number, GameMenu>();

/** Flujo agregar usuario: 1 = ID, 2 = Nombre, 3 = Teléfono. Clave = from.id del dueño. */
type AddingStep = { step: 1; userId?: number } | { step: 2; userId: number; name?: string } | { step: 3; userId: number; name: string; phone?: string };
const addingUserFlow = new Map<number, AddingStep>();

/** Flujo crear menú: step 1 = esperando id, step 2 = esperando label. */
const creatingMenuFlow = new Map<number, { step: 1 } | { step: 2; id: string }>();
/** Flujo editar menú: esperando nuevo label. */
const editingMenuFlow = new Map<number, { menuId: string }>();
/** Flujo eliminar menú: esperando confirmación (ya mostramos Sí/No en teclado). */
const deletingMenuFlow = new Map<number, { menuId: string }>();

function buildSecurityKeyboard(): InlineKeyboard {
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

/** Teclado del submenú Gestionar menús (listar, crear, editar, eliminar) + acceso a asignar a usuarios. */
function buildManageMenusKeyboard(): InlineKeyboard {
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

/** Una línea de texto con ID, nombre y teléfono del usuario (para listas en Seguridad). */
function formatUserLine(uid: number): string {
  const name = getUsername(uid) || "—";
  const phone = getPhone(uid);
  return `• \`${uid}\` — ${name} — ${phone ? "📞 " + phone : "—"}`;
}

/** Teclado: una fila por menú extra (registry) con ➕ y ➖. */
function buildUserMenusKeyboard(uid: number): InlineKeyboard {
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

bot.command("admin", async (ctx) => {
  if (!isOwner(ctx.from?.id ?? 0)) return;
  await ctx.reply("🔒 *Seguridad* — Gestiona quién puede usar el bot y sus menús.", {
    parse_mode: "Markdown",
    reply_markup: buildSecurityKeyboard(),
  });
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  let result: string;
  let keyboard: InlineKeyboard = buildMainKeyboard(ctx.from?.id);
  const asyncData =
    /^(fijo|corrido|ambos)_(hoy|ayer|semana)$/.test(data) ||
    data === "stats_grupos_M" ||
    data === "stats_grupos_E" ||
    data === "stats_individual_M" ||
    data === "stats_individual_E" ||
    (data.startsWith(EXTRA_MENU_CALLBACK_PREFIX) && !!getHandler(data.slice(EXTRA_MENU_CALLBACK_PREFIX.length)));

  if (data === "help") {
    result = "*❓ Ayuda*\n\n" + HELP_TEXT;
  } else if ((data === "security_open" || data === "security_main" || data.startsWith("admin_")) && ctx.from && isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery();
    if (data === "security_open") {
      result = "🔒 *Seguridad* — Gestiona quién puede usar el bot y sus menús.";
      keyboard = buildSecurityKeyboard();
    } else if (data === "security_main") {
      addingUserFlow.delete(ctx.from.id);
      result = "👋 Elige juego y luego el período:";
      keyboard = buildMainKeyboard(ctx.from?.id);
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
      result = "➕ *Agregar acceso* (paso 1/3)\n\nEnvía el *ID* del usuario (número). El usuario puede ver su ID escribiendo /start sin acceso.\n\n/cancel para cancelar.";
      keyboard = new InlineKeyboard().text("◀️ Cancelar", "security_open");
    } else if (data === "admin_remove") {
      const list = getAllowedUsers();
      const slice = list.slice(0, 30);
      result =
        list.length === 0
          ? "➖ *Quitar acceso*\n\n_No hay usuarios con acceso_ (solo tú como dueño)."
          : "➖ *Quitar acceso*\n\nToca ❌ para quitar el acceso a ese usuario.\n\n" + slice.map(formatUserLine).join("\n");
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
            : `✅ Usuario \`${uid}\` sin acceso. Toca ❌ para quitar a otro:\n\n` + slice.map(formatUserLine).join("\n");
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
        "📋 *Menús por usuario*\n\nElige un usuario para asignar menús extra:\n\n" + slice.map(formatUserLine).join("\n");
      keyboard = new InlineKeyboard();
      for (const uid of slice) {
        const label = getUsername(uid) ? `${getUsername(uid)} (${uid})` : `Usuario ${uid}`;
        keyboard.text(label.length > 64 ? `Usuario ${uid}` : label, `admin_menus_${uid}`).row();
      }
      keyboard.text("◀️ Volver a Seguridad", "security_open");
    } else if (/^admin_menus_\d+$/.test(data)) {
      const uid = parseInt(data.replace("admin_menus_", ""), 10);
      keyboard = buildUserMenusKeyboard(uid);
      const extra = getExtraMenus(uid);
      const ids = getExtraMenuIds();
      const menuList = ids.map((id) => `• ${getExtraMenuLabel(id) ?? id}${extra.includes(id) ? " ✓" : ""}`).join("\n");
      result = `📋 *Menús para usuario* \`${uid}\`\n\nCada fila: ➕ dar acceso, ➖ quitar acceso.\n\n${menuList}`;
    } else if (data.startsWith("admin_menu_add_")) {
      const rest = data.replace("admin_menu_add_", "");
      const [uidStr, menuId] = rest.includes("|") ? rest.split("|") : [rest.split("_")[0], rest.split("_").slice(1).join("_")];
      const uid = parseInt(uidStr!, 10);
      const validIds = getExtraMenuIds();
      if (Number.isNaN(uid) || !validIds.includes(menuId)) {
        result = "Error.";
        keyboard = buildSecurityKeyboard();
      } else {
        const extra = getExtraMenus(uid);
        if (!extra.includes(menuId)) await toggleExtraMenu(uid, menuId);
        keyboard = buildUserMenusKeyboard(uid);
        const extraAfter = getExtraMenus(uid);
        const menuList = validIds.map((id) => `• ${getExtraMenuLabel(id) ?? id}${extraAfter.includes(id) ? " ✓" : ""}`).join("\n");
        result = `📋 *Menús para usuario* \`${uid}\`\n\n✅ Acceso dado: ${getExtraMenuLabel(menuId) ?? menuId}\n\n${menuList}`;
      }
    } else if (data.startsWith("admin_menu_remove_")) {
      const rest = data.replace("admin_menu_remove_", "");
      const [uidStr, menuId] = rest.includes("|") ? rest.split("|") : [rest.split("_")[0], rest.split("_").slice(1).join("_")];
      const uid = parseInt(uidStr!, 10);
      const validIds = getExtraMenuIds();
      if (Number.isNaN(uid) || !validIds.includes(menuId)) {
        result = "Error.";
        keyboard = buildSecurityKeyboard();
      } else {
        const extra = getExtraMenus(uid);
        if (extra.includes(menuId)) await toggleExtraMenu(uid, menuId);
        keyboard = buildUserMenusKeyboard(uid);
        const extraAfter = getExtraMenus(uid);
        const menuList = validIds.map((id) => `• ${getExtraMenuLabel(id) ?? id}${extraAfter.includes(id) ? " ✓" : ""}`).join("\n");
        result = `📋 *Menús para usuario* \`${uid}\`\n\n❌ Acceso quitado: ${getExtraMenuLabel(menuId) ?? menuId}\n\n${menuList}`;
      }
    } else if (data === "admin_back") {
      addingUserFlow.delete(ctx.from!.id);
      creatingMenuFlow.delete(ctx.from!.id);
      editingMenuFlow.delete(ctx.from!.id);
      deletingMenuFlow.delete(ctx.from!.id);
      result = "🔒 *Seguridad* — Gestiona quién puede usar el bot y sus menús.";
      keyboard = buildSecurityKeyboard();
    } else if (data === "admin_menus_manage") {
      result = "⚙️ *Gestionar menús*\n\nLista, crea, edita o elimina menús extra (los que luego asignas a usuarios).";
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
      creatingMenuFlow.set(ctx.from!.id, { step: 1 });
      result = "➕ *Crear menú* (paso 1/2)\n\nEnvía el *id* del menú (solo letras, números y _; ej: \`fechas_calor\`).\n\n/cancel para cancelar.";
      keyboard = new InlineKeyboard().text("◀️ Cancelar", "admin_menus_manage");
    } else if (data === "admin_menus_edit") {
      const custom = getCustomMenus();
      if (custom.length === 0) {
        result = "✏️ *Editar menú*\n\n_No hay menús creados por ti._ Solo se pueden editar los que hayas creado desde aquí.";
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
        editingMenuFlow.set(ctx.from!.id, { menuId });
        const label = getExtraMenuLabel(menuId) ?? menuId;
        result = `✏️ *Editar menú* \`${menuId}\`\n\nEnvía el *nuevo texto* del botón (ahora: ${label}).\n\n/cancel para cancelar.`;
        keyboard = new InlineKeyboard().text("◀️ Cancelar", "admin_menus_manage");
      }
    } else if (data === "admin_menus_delete") {
      const custom = getCustomMenus();
      if (custom.length === 0) {
        result = "🗑 *Eliminar menú*\n\n_No hay menús creados por ti._ Solo se pueden eliminar los que hayas creado desde aquí.";
        keyboard = new InlineKeyboard().text("◀️ Volver a Gestionar menús", "admin_menus_manage");
      } else {
        result = "🗑 *Eliminar menú*\n\nElige el menú a eliminar (se quitará de todos los usuarios):";
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
        deletingMenuFlow.set(ctx.from!.id, { menuId });
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
      deletingMenuFlow.delete(ctx.from!.id);
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
      deletingMenuFlow.delete(ctx.from!.id);
      result = "⚙️ *Gestionar menús*\n\nLista, crea, edita o elimina menús extra.";
      keyboard = buildManageMenusKeyboard();
    } else {
      result = "🔒 *Seguridad* — Gestiona quién puede usar el bot y sus menús.";
      keyboard = buildSecurityKeyboard();
    }
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  } else if (data === "menu_fijo") {
    await ctx.answerCallbackQuery();
    result = "🎯 *Fijo* (P3)\n\nElige período (☀️ Mediodía y 🌙 Noche):";
    keyboard = buildSubmenuKeyboard("fijo");
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  } else if (data === "menu_corrido") {
    await ctx.answerCallbackQuery();
    result = "🎲 *Corrido* (P4)\n\nElige período (☀️ Mediodía y 🌙 Noche):";
    keyboard = buildSubmenuKeyboard("corrido");
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  } else if (data === "menu_ambos") {
    await ctx.answerCallbackQuery();
    result = "☀️🌙 *Ambos* — Fijo y Corrido\n\nElige período:";
    keyboard = buildSubmenuKeyboard("ambos");
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  } else if (data.startsWith(EXTRA_MENU_CALLBACK_PREFIX)) {
    const menuId = data.slice(EXTRA_MENU_CALLBACK_PREFIX.length);
    const handler = getHandler(menuId);
    if (handler) {
      await handler(ctx);
      return;
    }
  }
  if (data === "volver") {
    await ctx.answerCallbackQuery();
    result = "👋 Elige juego y luego el período:";
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  } else if (data === "stats_set_days") {
    await ctx.answerCallbackQuery();
    result = `🔢 *Días de diferencia* (valor actual: ${hotThresholdDays})\n\nSi (Máx.hist − Máx.actual) ≤ N, el grupo se marca 🔥 Hot. Elige N:`;
    keyboard = buildDiasDiferenciaKeyboard();
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  } else if (/^stats_days_\d+$/.test(data)) {
    const n = parseInt(data.replace("stats_days_", ""), 10);
    if (n >= 1 && n <= 30) hotThresholdDays = n;
    await ctx.answerCallbackQuery({ text: `Días diferencia = ${hotThresholdDays}` });
    result = "📊 *Estadísticas por grupos* (Fijo P3)\n\nElige *Mediodía (M)* o *Noche (E)*. Grupos: terminales (0-9), iniciales (0-9), dobles.\n\n🔥 Hot = (Máx.hist − Máx.actual) ≤ Días diferencia.";
    keyboard = buildEstadisticasKeyboard();
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  } else if (data === "stats_grupos_M" || data === "stats_grupos_E") {
    const period = data === "stats_grupos_M" ? "M" : "E";
    await ctx.answerCallbackQuery({ text: "Calculando estadísticas…" });
    try {
      const map3 = await getP3Map();
      result = buildGroupStatsMessageFromStats(map3, hotThresholdDays, period);
      keyboard = buildMainKeyboard(ctx.from?.id);
    } catch (e) {
      console.error("Group stats error:", e);
      result = "No pude cargar el historial P3. Prueba más tarde.";
    }
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!msg.includes("message is not modified")) console.error("Error en callback_query:", err);
    }
    return;
  } else if (data === "stats_individual_M" || data === "stats_individual_E") {
    const period = data === "stats_individual_M" ? "M" : "E";
    await ctx.answerCallbackQuery({ text: "Calculando…" });
    try {
      const map3 = await getP3Map();
      result = buildIndividualTop10MessageFromStats(map3, hotThresholdDays, period);
      keyboard = buildMainKeyboard(ctx.from?.id);
    } catch (e) {
      console.error("Individual stats error:", e);
      result = "No pude cargar el historial P3. Prueba más tarde.";
    }
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (!msg.includes("message is not modified")) console.error("Error en callback_query:", err);
    }
    return;
  } else if (data === "fijo_fecha" || data === "corrido_fecha" || data === "ambos_fecha") {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    const game: GameMenu = data === "fijo_fecha" ? "fijo" : data === "corrido_fecha" ? "corrido" : "ambos";
    if (userId) {
      waitingCustomDateGame.set(userId, game);
      const label = game === "fijo" ? "Fijo (P3)" : game === "corrido" ? "Corrido (P4)" : "Fijo y Corrido";
      result = `📅 *Escoger fecha — ${label}*\n\nEscribe la fecha en *MM/DD/AA* (ej: 02/25/26).\n\nUsa /cancel para cancelar.`;
    } else {
      result = "No se pudo iniciar.";
    }
    keyboard = buildMainKeyboard(ctx.from?.id);
    try {
      await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
    } catch (e) {
      if (!(e as Error).message?.includes("message is not modified")) console.error(e);
    }
    return;
  }

  const match = data.match(/^(fijo|corrido|ambos)_(hoy|ayer|semana)$/);
  if (match) {
    const [, game, scope] = match as [string, GameMenu, "hoy" | "ayer" | "semana"];
    const label = game === "fijo" ? "Fijo" : game === "corrido" ? "Corrido" : "Fijo y Corrido";
    await ctx.answerCallbackQuery({ text: `Cargando ${label}…` });
    try {
      const [map3, map4] = await Promise.all([getP3Map(), getP4Map()]);
      if (scope === "hoy") {
        const key = getTodayFloridaMMDDYY();
        const d3 = map3[key] ?? {};
        const d4 = map4[key] ?? {};
        result = buildResultOneDay(key, d3, d4, game, "Hoy");
      } else if (scope === "ayer") {
        const key = getYesterdayFloridaMMDDYY();
        const d3 = map3[key] ?? {};
        const d4 = map4[key] ?? {};
        result = buildResultOneDay(key, d3, d4, game, "Ayer");
      } else {
        const dates = getThisWeekFloridaMMDDYY();
        result = buildResultWeek(map3, map4, dates, game);
      }
      keyboard = buildMainKeyboard(ctx.from?.id);
    } catch (e) {
      console.error("PDF map error:", e);
      result = "No pude cargar los PDF. Prueba más tarde.";
    }
  } else {
    result = "Opción no reconocida. Usa /start para ver el menú.";
  }

  try {
    if (!asyncData) await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageText(result, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch (err) {
    if (!asyncData) await ctx.answerCallbackQuery({ text: "Listo ✓" }).catch(() => {});
    const msg = (err as Error).message ?? "";
    if (!msg.includes("message is not modified")) console.error("Error en callback_query:", err);
  }
});

function buildResultOneDay(
  key: string,
  d3: { m?: number[]; e?: number[] },
  d4: { m?: number[]; e?: number[] },
  game: GameMenu,
  title: string
): string {
  if (game === "fijo") {
    return `☀️🌙 *${title}* (Fijo) ${key}\n\n` + formatDrawsForMessage(key, d3);
  }
  if (game === "corrido") {
    return `☀️🌙 *${title}* (Corrido) ${key}\n\n` + formatDrawsForMessage(key, d4);
  }
  return (
    `☀️🌙 *${title}* ${key}\n\n*Fijo*\n` + formatDrawsForMessage(key, d3) +
    "\n\n*Corrido*\n" + formatDrawsForMessage(key, d4)
  );
}

function buildResultWeek(
  map3: Record<string, { m?: number[]; e?: number[] }>,
  map4: Record<string, { m?: number[]; e?: number[] }>,
  dates: string[],
  game: GameMenu
): string {
  let body = "📆 *Esta semana*";
  if (game === "fijo") body += " — Fijo (P3)";
  else if (game === "corrido") body += " — Corrido (P4)";
  body += "\n\n";
  for (const key of dates) {
    const d3 = map3[key];
    const d4 = map4[key];
    if (game === "fijo" && d3 && (d3.m || d3.e)) {
      body += `*${key}*\n` + formatDrawsForMessage(key, d3).replace(/^\*[^*]+\*\n/, "") + "\n\n";
    } else if (game === "corrido" && d4 && (d4.m || d4.e)) {
      body += `*${key}*\n` + formatDrawsForMessage(key, d4).replace(/^\*[^*]+\*\n/, "") + "\n\n";
    } else if (game === "ambos" && ((d3 && (d3.m || d3.e)) || (d4 && (d4.m || d4.e)))) {
      body += `*${key}*\n`;
      if (d3 && (d3.m || d3.e)) body += "Fijo: " + formatDrawsForMessage(key, d3).replace(/^\*[^*]+\*\n/, "") + "\n";
      if (d4 && (d4.m || d4.e)) body += "Corrido: " + formatDrawsForMessage(key, d4).replace(/^\*[^*]+\*\n/, "") + "\n";
      body += "\n";
    }
  }
  return body.trim() || "_Sin datos para estos días._";
}

bot.command("cancel", async (ctx) => {
  const userId = ctx.from?.id;
  if (userId) {
    waitingCustomDateGame.delete(userId);
    addingUserFlow.delete(userId);
    creatingMenuFlow.delete(userId);
    editingMenuFlow.delete(userId);
    deletingMenuFlow.delete(userId);
  }
  await ctx.reply("Cancelado.", { reply_markup: buildMainKeyboard(ctx.from?.id) });
});

bot.on("message:text", async (ctx) => {
  const userId = ctx.from?.id;
  const text = ctx.message.text.trim();

  if (userId && isOwner(userId)) {
    const flow = addingUserFlow.get(userId);
    if (flow) {
      if (flow.step === 1) {
        const id = parseInt(text, 10);
        if (Number.isNaN(id) || id < 0) {
          await ctx.reply("ID inválido. Usa un número (ej: 123456789).");
          return;
        }
        addingUserFlow.set(userId, { step: 2, userId: id });
        await ctx.reply("➕ *Agregar acceso* (paso 2/3)\n\nEnvía el *Nombre* del usuario.", {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("◀️ Cancelar", "security_open"),
        });
        return;
      }
      if (flow.step === 2) {
        const name = text.trim();
        if (!name) {
          await ctx.reply("Escribe un nombre (texto).");
          return;
        }
        addingUserFlow.set(userId, { step: 3, userId: flow.userId, name });
        await ctx.reply("➕ *Agregar acceso* (paso 3/3)\n\nEnvía el *Teléfono* del usuario.", {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("◀️ Cancelar", "security_open"),
        });
        return;
      }
      if (flow.step === 3) {
        const phone = text.trim();
        addingUserFlow.delete(userId);
        await addAllowed(flow.userId);
        await setUserInfo(flow.userId, { name: flow.name, phone: phone || undefined });
        await ctx.reply(
          `✅ Usuario agregado.\n\nID: \`${flow.userId}\`\nNombre: ${flow.name}\nTeléfono: ${phone || "—"}`,
          { parse_mode: "Markdown", reply_markup: buildSecurityKeyboard() }
        );
        return;
      }
    }

    const creating = creatingMenuFlow.get(userId);
    if (creating) {
      if (creating.step === 1) {
        const id = text.trim().replace(/\s+/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
        if (!id) {
          await ctx.reply("Escribe un id (letras, números y _; ej: fechas_calor).");
          return;
        }
        if (getExtraMenuIds().includes(id)) {
          await ctx.reply("Ese id ya existe. Elige otro.");
          return;
        }
        creatingMenuFlow.set(userId, { step: 2, id });
        await ctx.reply("➕ *Crear menú* (paso 2/2)\n\nEnvía el *texto del botón* (ej: 📅 Fechas Calor).", {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("◀️ Cancelar", "admin_menus_manage"),
        });
        return;
      }
      if (creating.step === 2) {
        const label = text.trim() || creating.id;
        creatingMenuFlow.delete(userId);
        if (!addCustomMenu(creating.id, label)) {
          await ctx.reply("No se pudo crear (id duplicado).", { reply_markup: buildManageMenusKeyboard() });
          return;
        }
        registerExtraMenu(creating.id, label, (ctx) => placeholderMenuHandler(ctx));
        const kb = new InlineKeyboard()
          .text("📋 Asignar a usuarios", "admin_menus")
          .row()
          .text("◀️ Volver a Gestionar menús", "admin_menus_manage");
        await ctx.reply(`✅ Menú creado: *${label}* (\`${creating.id}\`). Toca *Asignar a usuarios* para dar acceso a quien quieras.`, {
          parse_mode: "Markdown",
          reply_markup: kb,
        });
        return;
      }
    }

    const editing = editingMenuFlow.get(userId);
    if (editing) {
      const newLabel = text.trim();
      if (!newLabel) {
        await ctx.reply("Envía el nuevo texto del botón.");
        return;
      }
      editingMenuFlow.delete(userId);
      if (!updateCustomMenu(editing.menuId, newLabel)) {
        await ctx.reply("Error al actualizar.", { reply_markup: buildManageMenusKeyboard() });
        return;
      }
      updateExtraMenuLabel(editing.menuId, newLabel);
      await ctx.reply(`✅ Menú actualizado: *${newLabel}* (\`${editing.menuId}\`).`, {
        parse_mode: "Markdown",
        reply_markup: buildManageMenusKeyboard(),
      });
      return;
    }
  }

  const game = userId ? waitingCustomDateGame.get(userId) : undefined;
  if (!userId || game === undefined) return;
  waitingCustomDateGame.delete(userId);
  const key = parseUserDateToMMDDYY(text);
  if (!key) {
    await ctx.reply("❌ Fecha no válida. Usa MM/DD/AA (ej: 02/25/26).", {
      reply_markup: buildMainKeyboard(ctx.from?.id),
    });
    return;
  }
  try {
    const [map3, map4] = await Promise.all([getP3Map(), getP4Map()]);
    const d3 = map3[key] ?? {};
    const d4 = map4[key] ?? {};
    const msg = buildResultOneDay(key, d3, d4, game, "Fecha");
    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: buildMainKeyboard(ctx.from?.id) });
  } catch (e) {
    console.error("PDF map error:", e);
    await ctx.reply("No pude cargar los PDF. Prueba más tarde.", {
      reply_markup: buildMainKeyboard(ctx.from?.id),
    });
  }
});

/** PDF oficial Florida Lottery — Winning Numbers History (E: Evening, M: Midday). */
const P3_PDF_URL = "https://files.floridalottery.com/exptkt/p3.pdf";
const P4_PDF_URL = "https://files.floridalottery.com/exptkt/p4.pdf";

/** Tres números del sorteo (Pick 3). */
export type Pick3Numbers = [number, number, number];

/** Por fecha: sorteos de mediodía (m) y/o noche (e). */
export type DateDraws = {
  m?: Pick3Numbers;
  e?: Pick3Numbers;
};

/** Mapa: fecha (MM/DD/YY) → { m?: [n,n,n], e?: [n,n,n] }. */
export type DateDrawsMap = Record<string, DateDraws>;

/** Pick 4: cuatro números por sorteo. */
export type Pick4Numbers = [number, number, number, number];
export type DateDrawsP4 = { m?: Pick4Numbers; e?: Pick4Numbers };
export type DateDrawsMapP4 = Record<string, DateDrawsP4>;

/** Formatea un bloque de sorteos (m/e) para una fecha; sirve para P3 y P4. */
function formatDrawsForMessage(dateLabel: string, draws: { m?: number[]; e?: number[] }): string {
  let s = `*${dateLabel}*\n`;
  if (draws.m?.length) s += `☀️ Mediodía (M): \`${draws.m.join("-")}\`\n`;
  if (draws.e?.length) s += `🌙 Noche (E): \`${draws.e.join("-")}\`\n`;
  if (!draws.m?.length && !draws.e?.length) s += "_Sin datos_\n";
  return s.trim();
}

/** Fechas en Florida (MM/DD/YY). */
function getTodayFloridaMMDDYY(): string {
  const s = new Date().toLocaleDateString("en-CA", { timeZone: FLORIDA_TZ });
  const [y, m, d] = s.split("-");
  return `${m}/${d}/${y!.slice(-2)}`;
}
function getYesterdayFloridaMMDDYY(): string {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 864e5);
  const s = yesterday.toLocaleDateString("en-CA", { timeZone: FLORIDA_TZ });
  const [y, m, d] = s.split("-");
  return `${m}/${d}/${y!.slice(-2)}`;
}
/** Últimos 7 días (hoy + 6 anteriores) en MM/DD/YY. */
function getThisWeekFloridaMMDDYY(): string[] {
  const out: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const s = d.toLocaleDateString("en-CA", { timeZone: FLORIDA_TZ });
    const [y, m, day] = s.split("-");
    out.push(`${m}/${day}/${y!.slice(-2)}`);
  }
  return out;
}

/** Parsea entrada de usuario a MM/DD/YY para buscar en el mapa. Acepta MM/DD/YY, DD/MM/YY, YYYY-MM-DD. */
function parseUserDateToMMDDYY(text: string): string | null {
  const t = text.trim();
  const slash2 = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/;
  const dash = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
  let mm: number, dd: number, yy: number;
  const m2 = t.match(slash2);
  if (m2) {
    const a = parseInt(m2[1], 10);
    const b = parseInt(m2[2], 10);
    yy = parseInt(m2[3], 10);
    yy = yy >= 50 ? 1900 + yy : 2000 + yy;
    if (a > 12) {
      dd = a;
      mm = b;
    } else if (b > 12) {
      mm = a;
      dd = b;
    } else {
      mm = a;
      dd = b;
    }
  } else {
    const m1 = t.match(dash);
    if (!m1) return null;
    yy = parseInt(m1[1], 10);
    mm = parseInt(m1[2], 10);
    dd = parseInt(m1[3], 10);
  }
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  const lastDay = new Date(yy, mm, 0).getDate();
  if (dd > lastDay) return null;
  const yy2 = String(yy).slice(-2);
  return `${String(mm).padStart(2, "0")}/${String(dd).padStart(2, "0")}/${yy2}`;
}

/**
 * Parsea una línea con formato: fecha tipo(E|M) # - # - #
 * Acepta espacios y guiones entre los números. Ignora "FB N" si aparece.
 */
export function parseP3Line(line: string): { date: string; type: "e" | "m"; numbers: Pick3Numbers } | null {
  const trimmed = line.trim();
  const match = trimmed.match(
    /^(\d{2}\/\d{2}\/\d{2})\s+([EM])\s+(\d)\s*[\s\-]*\s*(\d)\s*[\s\-]*\s*(\d)(?:\s+FB\s+\d)?/i
  );
  if (!match) return null;
  const [, date, type, n1, n2, n3] = match;
  const period = type.toUpperCase() === "E" ? "e" : "m";
  return {
    date,
    type: period,
    numbers: [Number(n1), Number(n2), Number(n3)],
  };
}

/**
 * A partir de un listado de líneas de texto, construye el mapa fecha → { e?, m? }.
 */
export function buildDateDrawsMap(lines: string[]): DateDrawsMap {
  const map: DateDrawsMap = {};
  for (const line of lines) {
    const parsed = parseP3Line(line);
    if (!parsed) continue;
    if (!map[parsed.date]) map[parsed.date] = {};
    map[parsed.date][parsed.type] = parsed.numbers;
  }
  return map;
}

/**
 * Patrones que identificamos en el PDF (Florida Lottery PICK 3):
 *   MM/DD/YY E #-#-# FB #   (Evening)
 *   MM/DD/YY M #-#-# FB #   (Midday)
 * Los tres números pueden ir con guiones o espacios (#-#-# o # # #). "FB N" es opcional.
 */
const P3_RECORD_REGEX =
  /(\d{2}\/\d{2}\/\d{2})\s*([EM])\s*(\d)[\s\-]*(\d)[\s\-]*(\d)(?:\s+FB\s*(\d))?/gi;

/**
 * Parsea el texto extraído del PDF buscando todos los registros que coincidan con
 * MM/DD/YY E #-#-# FB # o MM/DD/YY M #-#-# FB # (varias columnas o líneas concatenadas).
 */
export function parseP3FullText(text: string): DateDrawsMap {
  const map: DateDrawsMap = {};
  const normalized = text
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let m: RegExpExecArray | null;
  P3_RECORD_REGEX.lastIndex = 0;
  while ((m = P3_RECORD_REGEX.exec(normalized)) !== null) {
    const date = m[1]!;
    const type = m[2]!.toUpperCase() === "E" ? "e" : "m";
    const numbers: Pick3Numbers = [Number(m[3]), Number(m[4]), Number(m[5])];
    if (!map[date]) map[date] = {};
    map[date][type] = numbers;
    // m[6] sería el Fireball si se quiere guardar más adelante
  }
  return map;
}

/** Pick 4: MM/DD/YY E/M #-#-#-# FB # */
const P4_RECORD_REGEX =
  /(\d{2}\/\d{2}\/\d{2})\s*([EM])\s*(\d)[\s\-]*(\d)[\s\-]*(\d)[\s\-]*(\d)(?:\s+FB\s*(\d))?/gi;

function parseP4FullText(text: string): DateDrawsMapP4 {
  const map: DateDrawsMapP4 = {};
  const normalized = text
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let m: RegExpExecArray | null;
  P4_RECORD_REGEX.lastIndex = 0;
  while ((m = P4_RECORD_REGEX.exec(normalized)) !== null) {
    const date = m[1]!;
    const type = m[2]!.toUpperCase() === "E" ? "e" : "m";
    const numbers: Pick4Numbers = [Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
    if (!map[date]) map[date] = {};
    map[date][type] = numbers;
  }
  return map;
}

/** Convierte un buffer PDF a texto usando Mozilla PDF.js (pdfjs-dist). No usa pdf-parse. */
async function pdfToText(pdfBuffer: ArrayBuffer): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(pdfBuffer);
  const standardFontsDir = path.join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts");
  const standardFontDataUrl = pathToFileURL(standardFontsDir + path.sep).href;
  const doc = await pdfjsLib.getDocument({
    data,
    disableFontFace: true,
    standardFontDataUrl,
  }).promise;
  const numPages = doc.numPages;
  const pageTexts: string[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    type Item = { str: string; transform?: number[] };
    const rawItems = content.items as Item[];
    // Ordenar por posición: arriba-abajo (y desc), izquierda-derecha (x asc) para columnas.
    const items = [...rawItems].sort((a, b) => {
      const yA = a.transform?.[5] ?? 0;
      const yB = b.transform?.[5] ?? 0;
      const xA = a.transform?.[4] ?? 0;
      const xB = b.transform?.[4] ?? 0;
      if (Math.abs(yA - yB) > 2) return yB - yA;
      return xA - xB;
    });
    let lastY: number | null = null;
    const lineParts: string[] = [];
    const lines: string[] = [];

    for (const item of items) {
      const y = item.transform?.[5] ?? 0;
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(lineParts.join(" ").trim());
        lineParts.length = 0;
      }
      lastY = y;
      lineParts.push(item.str);
    }
    if (lineParts.length > 0) lines.push(lineParts.join(" ").trim());
    pageTexts.push(lines.join("\n"));
  }

  return pageTexts.join("\n");
}

let cachedP3Map: DateDrawsMap | null = null;
let cachedP4Map: DateDrawsMapP4 | null = null;

/** Obtiene el mapa Pick 3 (carga p3.pdf si hace falta). */
async function getP3Map(): Promise<DateDrawsMap> {
  if (cachedP3Map) return cachedP3Map;
  const res = await fetch(P3_PDF_URL, { headers: { "User-Agent": "FloridaLotteryBot/1.0" } });
  if (!res.ok) throw new Error(`P3 PDF ${res.status}`);
  const txt = await pdfToText(await res.arrayBuffer());
  cachedP3Map = parseP3FullText(txt);
  return cachedP3Map;
}

/** Obtiene el mapa Pick 4 (carga p4.pdf si hace falta). */
async function getP4Map(): Promise<DateDrawsMapP4> {
  if (cachedP4Map) return cachedP4Map;
  const res = await fetch(P4_PDF_URL, { headers: { "User-Agent": "FloridaLotteryBot/1.0" } });
  if (!res.ok) throw new Error(`P4 PDF ${res.status}`);
  const txt = await pdfToText(await res.arrayBuffer());
  cachedP4Map = parseP4FullText(txt);
  return cachedP4Map;
}

/**
 * Lee el PDF desde https://files.floridalottery.com/exptkt/p3.pdf, extrae el texto
 * e identifica los patrones MM/DD/YY E #-#-# FB # y MM/DD/YY M #-#-# FB # para construir
 * el mapa fecha → { e?, m? } con los tres números por sorteo.
 */
async function printP3PdfLines(): Promise<void> {
  try {
    const res = await fetch(P3_PDF_URL, {
      headers: { "User-Agent": "FloridaLotteryBot/1.0" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const ab = await res.arrayBuffer();
    const txt = await pdfToText(ab);
    const map = parseP3FullText(txt);
    console.log("--- PDF P3 → Mapa fecha → { e?, m? } (#-#-#) ---");
    console.log(JSON.stringify(map, null, 2));
    console.log("--- fin PDF P3 ---");
  } catch (e) {
    console.error("Error leyendo PDF P3:", e);
  }
}

async function main(): Promise<void> {
  if (!BOT_TOKEN) {
    console.error("Configura TELEGRAM_BOT_TOKEN en el entorno.");
    process.exit(1);
  }
  if (process.env.PORT && !WEBHOOK_URL) {
    console.error("En este entorno debes definir WEBHOOK_URL (ej: https://tu-app.onrender.com).");
    process.exit(1);
  }

  await initUserConfig();
  registerExtraMenus();
  for (const m of initCustomMenus()) {
    registerExtraMenu(m.id, m.label, (ctx) => placeholderMenuHandler(ctx));
  }
  await bot.init();

  await bot.api.setMyCommands([
    { command: "start", description: "Iniciar y ver opciones" },
    { command: "help", description: "Ver ayuda" },
    { command: "cancel", description: "Cancelar y volver al menú" },
  ]);

  if (WEBHOOK_URL) {
    const webhookPath = "/webhook";
    const fullUrl = `${WEBHOOK_URL.replace(/\/$/, "")}${webhookPath}`;
    await bot.api.setWebhook(fullUrl);

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("OK");
        return;
      }
      if (req.method === "POST" && req.url === webhookPath) {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
          let update: Update;
          try {
            update = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Update;
          } catch {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Bad Request");
            return;
          }
          res.writeHead(200);
          res.end();
          bot.handleUpdate(update).catch((e) => console.error("Webhook handleUpdate error:", e));
        });
        req.on("error", () => {
          res.writeHead(500);
          res.end();
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(PORT);
  } else {
    await bot.start();
  }
}

main().catch(console.error);
