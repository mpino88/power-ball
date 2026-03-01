/**
 * Handler de mensajes de texto para flujos de Seguridad: agregar usuario, crear menú, editar menú.
 * Solo actúa si el usuario es dueño y está en uno de los flujos.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { addAllowed, setUserInfo, type PersistResult } from "../user-config.js";
import { getExtraMenuIds } from "../menu-registry.js";
import { addCustomMenu, updateCustomMenu } from "../custom-menus.js";
import { updateExtraMenuLabel } from "../menu-registry.js";
import { buildSecurityKeyboard, buildManageMenusKeyboard } from "./keyboards.js";
import { labelToMenuId } from "./menuIdFromLabel.js";
import {
  addingUserFlow,
  creatingMenuFlow,
  editingMenuFlow,
  clearAllFlows,
} from "./flows.js";

export interface SecurityMessageDeps {
  isOwner: (userId: number) => boolean;
  buildMainKeyboard: (userId: number | undefined) => InlineKeyboard;
  onMenuCreated: (id: string, label: string) => void;
}

/**
 * Procesa un mensaje de texto en contexto de Seguridad (flujos de dueño).
 * Retorna true si el mensaje fue consumido por un flujo; false para seguir con otros handlers.
 */
export async function handleSecurityMessage(
  ctx: Context,
  deps: SecurityMessageDeps
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (userId === undefined || !deps.isOwner(userId)) return false;

  const text = (ctx.message && "text" in ctx.message ? ctx.message.text : undefined)?.trim() ?? "";

  const flow = addingUserFlow.get(userId);
  if (flow) {
    if (flow.step === 1) {
      const id = parseInt(text, 10);
      if (Number.isNaN(id) || id < 0) {
        await ctx.reply("ID inválido. Usa un número (ej: 123456789).");
        return true;
      }
      addingUserFlow.set(userId, { step: 2, userId: id });
      await ctx.reply("➕ *Agregar acceso* (paso 2/3)\n\nEnvía el *Nombre* del usuario.", {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("◀️ Cancelar", "security_open"),
      });
      return true;
    }
    if (flow.step === 2) {
      const name = text.trim();
      if (!name) {
        await ctx.reply("Escribe un nombre (texto).");
        return true;
      }
      addingUserFlow.set(userId, { step: 3, userId: flow.userId, name });
      await ctx.reply("➕ *Agregar acceso* (paso 3/3)\n\nEnvía el *Teléfono* del usuario.", {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("◀️ Cancelar", "security_open"),
      });
      return true;
    }
    if (flow.step === 3) {
      const phone = text.trim();
      addingUserFlow.delete(userId);
      let resultAdd: PersistResult;
      let resultSave: PersistResult;
      try {
        resultAdd = await addAllowed(flow.userId);
        resultSave = await setUserInfo(flow.userId, { name: flow.name, phone: phone || undefined });
      } catch (e) {
        console.error("[security] Error al guardar usuario (Sheet/archivo):", e);
        await ctx.reply(
          "❌ Usuario agregado en memoria pero *falló al guardar* (error inesperado). Revisa logs.",
          { parse_mode: "Markdown", reply_markup: buildSecurityKeyboard() }
        );
        return true;
      }
      const backendLabel = resultSave.backend === "sheet" ? "Google Sheet" : "archivo (data/bot-users.json)";
      const addFailed = !resultAdd.ok;
      const saveFailed = !resultSave.ok;
      const anyFailed = addFailed || saveFailed;
      let logLine: string;
      if (!anyFailed) {
        logLine = `\n\n📁 _Guardado en: ${backendLabel} (${resultSave.count} usuarios)_`;
      } else {
        const errors: string[] = [];
        if (addFailed && resultAdd.error) errors.push(`1º guardado: ${resultAdd.error}`);
        if (saveFailed && resultSave.error) errors.push(`2º guardado: ${resultSave.error}`);
        logLine = `\n\n❌ _Error al guardar en ${backendLabel}: ${errors.join("; ") || "desconocido"}_`;
      }
      await ctx.reply(
        `✅ Usuario agregado.\n\nID: \`${flow.userId}\`\nNombre: ${flow.name}\nTeléfono: ${phone || "—"}${logLine}`,
        { parse_mode: "Markdown", reply_markup: buildSecurityKeyboard() }
      );
      return true;
    }
  }

  const creating = creatingMenuFlow.get(userId);
  if (creating) {
    const label = text.trim();
    if (!label) {
      await ctx.reply("Escribe el texto del botón (ej: 📅 Fechas Calor).");
      return true;
    }
    const id = labelToMenuId(label);
    if (!id) {
      await ctx.reply("El texto no genera un id válido. Usa letras o números (ej: Fechas Calor).");
      return true;
    }
    creatingMenuFlow.delete(userId);
    if (getExtraMenuIds().includes(id)) {
      await ctx.reply(
        `Ya existe un menú con ese texto (id: \`${id}\`). Elige otro texto para el botón.`,
        { parse_mode: "Markdown", reply_markup: buildManageMenusKeyboard() }
      );
      return true;
    }
    if (!addCustomMenu(id, label)) {
      await ctx.reply("No se pudo crear (id duplicado).", {
        reply_markup: buildManageMenusKeyboard(),
      });
      return true;
    }
    deps.onMenuCreated(id, label);
    const kb = new InlineKeyboard()
      .text("📋 Asignar a usuarios", "admin_menus")
      .row()
      .text("◀️ Volver a Gestionar menús", "admin_menus_manage");
    await ctx.reply(
      `✅ Menú creado: *${label}* (\`${id}\`).\n\nEl id \`${id}\` se usa para asignar la funcionalidad del botón. Toca *Asignar a usuarios* para dar acceso.`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
    return true;
  }

  const editing = editingMenuFlow.get(userId);
  if (editing) {
    const newLabel = text.trim();
    if (!newLabel) {
      await ctx.reply("Envía el nuevo texto del botón.");
      return true;
    }
    editingMenuFlow.delete(userId);
    if (!updateCustomMenu(editing.menuId, newLabel)) {
      await ctx.reply("Error al actualizar.", { reply_markup: buildManageMenusKeyboard() });
      return true;
    }
    updateExtraMenuLabel(editing.menuId, newLabel);
    await ctx.reply(`✅ Menú actualizado: *${newLabel}* (\`${editing.menuId}\`).`, {
      parse_mode: "Markdown",
      reply_markup: buildManageMenusKeyboard(),
    });
    return true;
  }

  return false;
}
