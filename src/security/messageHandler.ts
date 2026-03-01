/**
 * Handler de mensajes de texto para flujos de Seguridad: agregar usuario, crear menú, editar menú.
 * Solo actúa si el usuario es dueño y está en uno de los flujos.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import {
  addAllowed,
  setUserInfo,
  getSheetUnavailableReason,
  type PersistResult,
} from "../user-config.js";
import { getExtraMenuIds } from "../menu-registry.js";
import { addCustomMenu, updateCustomMenu } from "../custom-menus.js";
import { updateExtraMenuLabel } from "../menu-registry.js";
import { addPlan, updatePlan, titleToPlanId } from "../plans.js";
import { buildSecurityKeyboard, buildManageMenusKeyboard, buildManagePlansKeyboard } from "./keyboards.js";
import { labelToMenuId } from "./menuIdFromLabel.js";
import {
  addingUserFlow,
  creatingMenuFlow,
  editingMenuFlow,
  creatingPlanFlow,
  editingPlanFlow,
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
        if (resultSave.backend === "file") {
          const reason = getSheetUnavailableReason();
          if (reason) logLine += `\n\n⚠️ _Para usar Google Sheet:_ ${reason}`;
        }
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

  const creatingPlan = creatingPlanFlow.get(userId);
  if (creatingPlan) {
    if (creatingPlan.step === 1) {
      const title = text.trim();
      if (!title) {
        await ctx.reply("Envía el título del plan (ej: Plan Básico).");
        return true;
      }
      creatingPlanFlow.set(userId, { step: 2, title });
      await ctx.reply("➕ *Añadir plan* (paso 2/4)\n\nEnvía la *descripción* del plan.", {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("◀️ Cancelar", "admin_plans_manage"),
      });
      return true;
    }
    if (creatingPlan.step === 2) {
      const description = text.trim();
      creatingPlanFlow.set(userId, { step: 3, title: creatingPlan.title, description });
      await ctx.reply("➕ *Añadir plan* (paso 3/4)\n\nEnvía el *precio* (ej: Gratis, $5/mes, $50/año).", {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("◀️ Cancelar", "admin_plans_manage"),
      });
      return true;
    }
    if (creatingPlan.step === 3) {
      const price = text.trim();
      creatingPlanFlow.set(userId, { step: 4, title: creatingPlan.title, description: creatingPlan.description, price });
      await ctx.reply(
        "➕ *Añadir plan* (paso 4/4)\n\nEnvía los *IDs de menús* incluidos en este plan, separados por coma (ej: `est_grupos,est_individuales`). Quien apruebe este plan tendrá esos menús. Envía *-* para ninguno.",
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("◀️ Cancelar", "admin_plans_manage") }
      );
      return true;
    }
    if (creatingPlan.step === 4) {
      const raw = text.trim();
      const menuIds = raw === "-" || raw === "" ? [] : raw.split(",").map((s) => s.trim()).filter(Boolean);
      creatingPlanFlow.delete(userId);
      const id = titleToPlanId(creatingPlan.title);
      if (!addPlan(id, creatingPlan.title, creatingPlan.description, creatingPlan.price, menuIds)) {
        await ctx.reply("No se pudo añadir (id duplicado). Cambia el título.", {
          reply_markup: buildManagePlansKeyboard(),
        });
        return true;
      }
      const menuInfo = menuIds.length > 0 ? ` Menús: ${menuIds.join(", ")}.` : "";
      await ctx.reply(
        `✅ Plan *${creatingPlan.title}* añadido.\n\nPrecio: ${creatingPlan.price}.${menuInfo}\n\nLos usuarios sin acceso verán este plan; al aprobarlos se les asignarán estos menús.`,
        { parse_mode: "Markdown", reply_markup: buildManagePlansKeyboard() }
      );
      return true;
    }
  }

  const editingPlan = editingPlanFlow.get(userId);
  if (editingPlan) {
    if (editingPlan.step === 1) {
      const title = text.trim();
      if (!title) {
        await ctx.reply("Envía el nuevo título del plan.");
        return true;
      }
      editingPlanFlow.set(userId, { step: 2, planId: editingPlan.planId, title });
      await ctx.reply("✏️ *Editar plan* (paso 2/4)\n\nEnvía la *nueva descripción*.", {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("◀️ Cancelar", "admin_plans_manage"),
      });
      return true;
    }
    if (editingPlan.step === 2) {
      const description = text.trim();
      editingPlanFlow.set(userId, {
        step: 3,
        planId: editingPlan.planId,
        title: editingPlan.title,
        description,
      });
      await ctx.reply("✏️ *Editar plan* (paso 3/4)\n\nEnvía el *nuevo precio*.", {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("◀️ Cancelar", "admin_plans_manage"),
      });
      return true;
    }
    if (editingPlan.step === 3) {
      const price = text.trim();
      editingPlanFlow.set(userId, {
        step: 4,
        planId: editingPlan.planId,
        title: editingPlan.title,
        description: editingPlan.description,
        price,
      });
      await ctx.reply(
        "✏️ *Editar plan* (paso 4/4)\n\nEnvía los *IDs de menús* del plan (separados por coma) o *-* para ninguno.",
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("◀️ Cancelar", "admin_plans_manage") }
      );
      return true;
    }
    if (editingPlan.step === 4) {
      const raw = text.trim();
      const menuIds = raw === "-" || raw === "" ? [] : raw.split(",").map((s) => s.trim()).filter(Boolean);
      editingPlanFlow.delete(userId);
      updatePlan(editingPlan.planId, {
        title: editingPlan.title,
        description: editingPlan.description,
        price: editingPlan.price,
        menuIds,
      });
      await ctx.reply(`✅ Plan actualizado: *${editingPlan.title}* — ${editingPlan.price}`, {
        parse_mode: "Markdown",
        reply_markup: buildManagePlansKeyboard(),
      });
      return true;
    }
  }

  return false;
}
