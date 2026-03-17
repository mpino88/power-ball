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
  getAllowedUsers,
  type PersistResult,
} from "../user-config.js";
import { getExtraMenuIds } from "../menu-registry.js";
import { addCustomMenu } from "../custom-menus.js";
import { addPlan, updatePlan, titleToPlanId, getPlans } from "../plans.js";
import {
  buildSecurityKeyboard,
  buildManageEstrategiasKeyboard,
  buildManageEstrategiasKeyboardUser,
  buildManagePlansKeyboard,
} from "./keyboards.js";
import { labelToMenuId } from "./menuIdFromLabel.js";
import { escapeMd } from "./callbacks.js";
import {
  addingUserFlow,
  creatingMenuFlow,
  editingMenuFlow,
  creatingPlanFlow,
  editingPlanFlow,
  assigningPlanFlow,
  creatingPaymentMethodFlow,
  editingPaymentMethodFlow,
  updatingHoyFlow,
  generatingCacheFlow,
  clearAllFlows,
} from "./flows.js";
import { warmUpCandidateCache } from "../candidate-cache.js";
import {
  addAndSavePaymentMethod,
  updateAndSavePaymentMethod,
  getPaymentMethodById,
} from "../payment-methods.js";
import { saveHoyResult, getHoyResult } from "../hoy-results.js";

import { findWinningStrategies } from "../neuro-hit-engine.js";

export interface SecurityMessageDeps {
  isOwner: (userId: number) => boolean;
  buildMainKeyboard: (userId: number | undefined) => InlineKeyboard;
  /** createdBy = userId cuando la crea un usuario (se auto-asigna). */
  onMenuCreated: (id: string, label: string, description?: string, createdBy?: number) => void;
  getP3Map: () => Promise<any>;
  getP4Map: () => Promise<any>;
  getHotThresholdDays: () => number;
  getExtraMenuLabel: (id: string) => string | undefined;
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
  if (userId === undefined) return false;

  const text = (ctx.message && "text" in ctx.message ? ctx.message.text : undefined)?.trim() ?? "";

  const creating = creatingMenuFlow.get(userId);
  if (creating) {
    if (creating.step === 1) {
      const label = text.trim();
      if (!label) {
        const cancelData = creating.fromAdmin ? "admin_estrategias_manage" : "estrategias_manage";
        await ctx.reply("Escribe el *título* del botón. Ej: 📅 Fechas Calor.", {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("◀️ Cancelar", cancelData),
        });
        return true;
      }
      const id = labelToMenuId(label);
      if (!id) {
        await ctx.reply("El texto no genera un id válido. Usa letras o números (ej: Fechas Calor).");
        return true;
      }
      if (getExtraMenuIds().includes(id)) {
        const backKb = creating.createdBy != null ? buildManageEstrategiasKeyboardUser() : buildManageEstrategiasKeyboard();
        await ctx.reply(
          `Ya existe una estrategia con ese texto (id: \`${id}\`). Elige otro título.`,
          { parse_mode: "Markdown", reply_markup: backKb }
        );
        return true;
      }
      creatingMenuFlow.set(userId, { step: 2, label, createdBy: creating.createdBy, fromAdmin: creating.fromAdmin });
      const cancelData = creating.fromAdmin ? "admin_estrategias_manage" : "estrategias_manage";
      await ctx.reply("➕ *Crear estrategia* (paso 2/3)\n\nEnvía la *descripción* (qué hace la estrategia). Opcional: envía *-* para omitir.", {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("◀️ Cancelar", cancelData),
      });
      return true;
    }
    if (creating.step === 2) {
      const description = text.trim() === "-" || text.trim() === "" ? undefined : text.trim();
      creatingMenuFlow.set(userId, {
        step: 3,
        label: creating.label,
        description,
        createdBy: creating.createdBy,
        fromAdmin: creating.fromAdmin,
      });
      const cancelData = creating.createdBy != null ? "estrategias_manage" : "admin_estrategias_manage";
      await ctx.reply(
        "➕ *Crear estrategia* (paso 3/3)\n\nEnvía el *precio* (ej: $5 USD, Gratis). Se mostrará a usuarios que la soliciten fuera de su plan. Opcional: envía *-* para omitir.",
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard().text("◀️ Cancelar", cancelData) }
      );
      return true;
    }
    if (creating.step === 3) {
    const price = text.trim() === "-" || text.trim() === "" ? undefined : text.trim();
    const label = creating.label;
    const description = creating.description;
    const id = labelToMenuId(label)!;
    const createdBy = creating.createdBy;
    const fromAdmin = creating.fromAdmin ?? false;
    creatingMenuFlow.delete(userId);
    if (!addCustomMenu(id, label, description, createdBy, price, "private" /* nueva estrategia siempre privada */)) {
      const backKb = fromAdmin ? buildManageEstrategiasKeyboard() : buildManageEstrategiasKeyboardUser();
      await ctx.reply("No se pudo crear (id duplicado).", { reply_markup: backKb });
      return true;
    }
    deps.onMenuCreated(id, label, description, createdBy);
    const kb = new InlineKeyboard();
    if (fromAdmin) {
      kb.text("📋 Asignar a usuarios", "admin_menus").row();
      kb.text("◀️ Volver a Gestionar Estrategias", "admin_estrategias_manage");
    } else {
      kb.text("◀️ Volver a Gestionar estrategias", "estrategias_manage");
    }
    await ctx.reply(
      `✅ Estrategia creada: *${label}* (\`${id}\`). Se te ha asignado automáticamente.\n\nEstado: _pendiente de implementación_ hasta que se asocie una función.`,
      { parse_mode: "Markdown", reply_markup: kb }
    );
    }
    return true;
  }

  if (!deps.isOwner(userId)) return false;

  const assigningPlan = assigningPlanFlow.get(userId);
  if (assigningPlan?.step === 1) {
    const targetId = parseInt(text, 10);
    if (Number.isNaN(targetId) || targetId < 0) {
      await ctx.reply("ID inválido. Envía un número (ej: 123456789).", {
        reply_markup: new InlineKeyboard().text("◀️ Cancelar", "admin_assign_plan_cancel"),
      });
      return true;
    }
    assigningPlanFlow.set(userId, { step: 2, targetUserId: targetId });
    const plans = getPlans();
    if (plans.length === 0) {
      assigningPlanFlow.delete(userId);
      await ctx.reply("No hay planes. Crea uno en Gestionar planes.", {
        reply_markup: buildManagePlansKeyboard(),
      });
      return true;
    }
    const kb = new InlineKeyboard();
    for (const p of plans) {
      kb.text(`${p.title}`, `admin_assign_plan_${p.id}`).row();
    }
    kb.text("◀️ Cancelar", "admin_assign_plan_cancel");
    await ctx.reply(`👤 *Asignar plan al usuario \`${targetId}\`*\n\nElige el plan:`, {
      parse_mode: "Markdown",
      reply_markup: kb,
    });
    return true;
  }

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

  const creatingPlan = creatingPlanFlow.get(userId);
  if (creatingPlan) {
    const cancelKb = new InlineKeyboard().text("◀️ Cancelar", "admin_plans_manage");
    if (creatingPlan.step === 1) {
      const title = text.trim();
      if (!title) { await ctx.reply("Envía el título del plan (ej: Plan Básico)."); return true; }
      creatingPlanFlow.set(userId, { step: 2, title });
      await ctx.reply("➕ *Añadir plan* (paso 2/8)\n\nEnvía la *descripción* del plan.", { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }
    if (creatingPlan.step === 2) {
      creatingPlanFlow.set(userId, { step: 3, title: creatingPlan.title, description: text.trim() });
      await ctx.reply(
        "➕ *Añadir plan* (paso 3/8)\n\nEnvía los *IDs de menús* incluidos (ej: `est_grupos,est_individuales`). Envía *-* para ninguno.",
        { parse_mode: "Markdown", reply_markup: cancelKb }
      );
      return true;
    }
    if (creatingPlan.step === 3) {
      const raw = text.trim();
      const menuIds = raw === "-" || raw === "" ? [] : raw.split(",").map((s) => s.trim()).filter(Boolean);
      creatingPlanFlow.set(userId, { step: 4, title: creatingPlan.title, description: creatingPlan.description, menuIds });
      await ctx.reply("➕ *Añadir plan* (paso 4/8)\n\nPrecio para *1 Mes*. Envía *-* para omitir.", { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }
    if (creatingPlan.step === 4) {
      const price_1m = text.trim() === "-" ? "" : text.trim();
      creatingPlanFlow.set(userId, { step: 5, title: creatingPlan.title, description: creatingPlan.description, menuIds: creatingPlan.menuIds, price_1m });
      await ctx.reply("➕ *Añadir plan* (paso 5/8)\n\nPrecio para *3 Meses*. Envía *-* para omitir.", { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }
    if (creatingPlan.step === 5) {
      const price_3m = text.trim() === "-" ? "" : text.trim();
      creatingPlanFlow.set(userId, { step: 6, title: creatingPlan.title, description: creatingPlan.description, menuIds: creatingPlan.menuIds, price_1m: creatingPlan.price_1m, price_3m });
      await ctx.reply("➕ *Añadir plan* (paso 6/8)\n\nPrecio para *6 Meses*. Envía *-* para omitir.", { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }
    if (creatingPlan.step === 6) {
      const price_6m = text.trim() === "-" ? "" : text.trim();
      creatingPlanFlow.set(userId, { step: 7, title: creatingPlan.title, description: creatingPlan.description, menuIds: creatingPlan.menuIds, price_1m: creatingPlan.price_1m, price_3m: creatingPlan.price_3m, price_6m });
      await ctx.reply("➕ *Añadir plan* (paso 7/8)\n\nPrecio para *9 Meses*. Envía *-* para omitir.", { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }
    if (creatingPlan.step === 7) {
      const price_9m = text.trim() === "-" ? "" : text.trim();
      creatingPlanFlow.set(userId, { step: 8, title: creatingPlan.title, description: creatingPlan.description, menuIds: creatingPlan.menuIds, price_1m: creatingPlan.price_1m, price_3m: creatingPlan.price_3m, price_6m: creatingPlan.price_6m, price_9m });
      await ctx.reply("➕ *Añadir plan* (paso 8/8)\n\nPrecio para *1 Año*. Envía *-* para omitir.", { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }
    if (creatingPlan.step === 8) {
      const price_1a = text.trim() === "-" ? "" : text.trim();
      creatingPlanFlow.delete(userId);
      const id = titleToPlanId(creatingPlan.title);
      const pricing = { price_1m: creatingPlan.price_1m, price_3m: creatingPlan.price_3m, price_6m: creatingPlan.price_6m, price_9m: creatingPlan.price_9m, price_1a };
      if (!addPlan(id, creatingPlan.title, creatingPlan.description, "", creatingPlan.menuIds, pricing)) {
        await ctx.reply("No se pudo añadir (id duplicado). Cambia el título.", { reply_markup: buildManagePlansKeyboard() });
        return true;
      }
      const menuInfo = creatingPlan.menuIds.length > 0 ? `\nMenús: ${creatingPlan.menuIds.join(", ")}.` : "";
      const priceInfo = [
        creatingPlan.price_1m && `1M: ${creatingPlan.price_1m}`,
        creatingPlan.price_3m && `3M: ${creatingPlan.price_3m}`,
        creatingPlan.price_6m && `6M: ${creatingPlan.price_6m}`,
        creatingPlan.price_9m && `9M: ${creatingPlan.price_9m}`,
        price_1a && `1A: ${price_1a}`,
      ].filter(Boolean).join(" · ");
      await ctx.reply(
        `✅ Plan *${creatingPlan.title}* añadido.${menuInfo}${priceInfo ? `\nPrecios: ${priceInfo}` : ""}`,
        { parse_mode: "Markdown", reply_markup: buildManagePlansKeyboard() }
      );
      return true;
    }
  }

  const editingPlan = editingPlanFlow.get(userId);
  if (editingPlan) {
    const cancelKb = new InlineKeyboard().text("◀️ Cancelar", "admin_plans_manage");
    if (editingPlan.step === 1) {
      const title = text.trim();
      if (!title) { await ctx.reply("Envía el nuevo título del plan."); return true; }
      editingPlanFlow.set(userId, { step: 2, planId: editingPlan.planId, title });
      await ctx.reply("✏️ *Editar plan* (paso 2/8)\n\nEnvía la *nueva descripción*.", { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }
    if (editingPlan.step === 2) {
      editingPlanFlow.set(userId, { step: 3, planId: editingPlan.planId, title: editingPlan.title, description: text.trim() });
      await ctx.reply(
        "✏️ *Editar plan* (paso 3/8)\n\nEnvía los *IDs de menús* del plan (separados por coma) o *-* para ninguno.",
        { parse_mode: "Markdown", reply_markup: cancelKb }
      );
      return true;
    }
    if (editingPlan.step === 3) {
      const raw = text.trim();
      const menuIds = raw === "-" || raw === "" ? [] : raw.split(",").map((s) => s.trim()).filter(Boolean);
      editingPlanFlow.set(userId, { step: 4, planId: editingPlan.planId, title: editingPlan.title, description: editingPlan.description, menuIds });
      await ctx.reply("✏️ *Editar plan* (paso 4/8)\n\nNuevo precio para *1 Mes*. Envía *-* para dejar vacío.", { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }
    if (editingPlan.step === 4) {
      const price_1m = text.trim() === "-" ? "" : text.trim();
      editingPlanFlow.set(userId, { step: 5, planId: editingPlan.planId, title: editingPlan.title, description: editingPlan.description, menuIds: editingPlan.menuIds, price_1m });
      await ctx.reply("✏️ *Editar plan* (paso 5/8)\n\nNuevo precio para *3 Meses*. Envía *-* para dejar vacío.", { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }
    if (editingPlan.step === 5) {
      const price_3m = text.trim() === "-" ? "" : text.trim();
      editingPlanFlow.set(userId, { step: 6, planId: editingPlan.planId, title: editingPlan.title, description: editingPlan.description, menuIds: editingPlan.menuIds, price_1m: editingPlan.price_1m, price_3m });
      await ctx.reply("✏️ *Editar plan* (paso 6/8)\n\nNuevo precio para *6 Meses*. Envía *-* para dejar vacío.", { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }
    if (editingPlan.step === 6) {
      const price_6m = text.trim() === "-" ? "" : text.trim();
      editingPlanFlow.set(userId, { step: 7, planId: editingPlan.planId, title: editingPlan.title, description: editingPlan.description, menuIds: editingPlan.menuIds, price_1m: editingPlan.price_1m, price_3m: editingPlan.price_3m, price_6m });
      await ctx.reply("✏️ *Editar plan* (paso 7/8)\n\nNuevo precio para *9 Meses*. Envía *-* para dejar vacío.", { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }
    if (editingPlan.step === 7) {
      const price_9m = text.trim() === "-" ? "" : text.trim();
      editingPlanFlow.set(userId, { step: 8, planId: editingPlan.planId, title: editingPlan.title, description: editingPlan.description, menuIds: editingPlan.menuIds, price_1m: editingPlan.price_1m, price_3m: editingPlan.price_3m, price_6m: editingPlan.price_6m, price_9m });
      await ctx.reply("✏️ *Editar plan* (paso 8/8)\n\nNuevo precio para *1 Año*. Envía *-* para dejar vacío.", { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }
    if (editingPlan.step === 8) {
      const price_1a = text.trim() === "-" ? "" : text.trim();
      editingPlanFlow.delete(userId);
      updatePlan(editingPlan.planId, {
        title: editingPlan.title,
        description: editingPlan.description,
        menuIds: editingPlan.menuIds,
        price_1m: editingPlan.price_1m,
        price_3m: editingPlan.price_3m,
        price_6m: editingPlan.price_6m,
        price_9m: editingPlan.price_9m,
        price_1a,
      });
      await ctx.reply(`✅ Plan actualizado: *${editingPlan.title}*`, { parse_mode: "Markdown", reply_markup: buildManagePlansKeyboard() });
      return true;
    }
  }

  // ─── Crear forma de pago ─────────────────────────────────────────────────
  const creatingPm = creatingPaymentMethodFlow.get(userId);
  if (creatingPm) {
    const cancelKb = new InlineKeyboard().text("◀️ Cancelar", "admin_pm_open");
    if (creatingPm.step === 1) {
      const description = text.trim();
      if (!description) {
        await ctx.reply("Envía la *descripción* de la forma de pago (ej: Zelle, PayPal).", { parse_mode: "Markdown", reply_markup: cancelKb });
        return true;
      }
      creatingPaymentMethodFlow.set(userId, { step: 2, description });
      await ctx.reply("💳 *Nueva forma de pago* (paso 2/3)\n\nEnvía el *número/cuenta* (ej: +1 305-555-0100 o usuario@example.com).", { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }
    if (creatingPm.step === 2) {
      const account = text.trim();
      if (!account) {
        await ctx.reply("Envía el número o cuenta.", { reply_markup: cancelKb });
        return true;
      }
      creatingPaymentMethodFlow.set(userId, { step: 3, description: creatingPm.description, account });
      await ctx.reply("💳 *Nueva forma de pago* (paso 3/3)\n\nEnvía la *moneda* (ej: USD, EUR).", { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }
    if (creatingPm.step === 3) {
      const currency = text.trim();
      creatingPaymentMethodFlow.delete(userId);
      const pm = await addAndSavePaymentMethod(creatingPm.description, creatingPm.account, currency || "USD");
      await ctx.reply(
        `✅ *Forma de pago creada*\n\n📌 ${pm.description}\n💳 ${pm.account}\n🌐 ${pm.currency}`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("◀️ Volver a Formas de pago", "admin_pm_open"),
        }
      );
      return true;
    }
  }

  // ─── Editar forma de pago ─────────────────────────────────────────────────
  const editingPm = editingPaymentMethodFlow.get(userId);
  if (editingPm) {
    const cancelKb = new InlineKeyboard().text("◀️ Cancelar", "admin_pm_open");
    const existing = getPaymentMethodById(editingPm.id);
    if (editingPm.step === 1) {
      const description = text.trim() === "-" ? (existing?.description ?? "") : text.trim();
      if (!description) {
        await ctx.reply("Envía la nueva descripción o *-* para mantener la actual.", { parse_mode: "Markdown", reply_markup: cancelKb });
        return true;
      }
      editingPaymentMethodFlow.set(userId, { step: 2, id: editingPm.id, description });
      await ctx.reply(
        `✏️ *Editar forma de pago* (paso 2/3)\n\nActual: \`${existing?.account ?? ""}\`\nEnvía el nuevo *número/cuenta* (o *-* para mantener).`,
        { parse_mode: "Markdown", reply_markup: cancelKb }
      );
      return true;
    }
    if (editingPm.step === 2) {
      const account = text.trim() === "-" ? (existing?.account ?? "") : text.trim();
      editingPaymentMethodFlow.set(userId, { step: 3, id: editingPm.id, description: editingPm.description, account });
      await ctx.reply(
        `✏️ *Editar forma de pago* (paso 3/3)\n\nActual: \`${existing?.currency ?? ""}\`\nEnvía la nueva *moneda* (o *-* para mantener).`,
        { parse_mode: "Markdown", reply_markup: cancelKb }
      );
      return true;
    }
    if (editingPm.step === 3) {
      const currency = text.trim() === "-" ? (existing?.currency ?? "USD") : text.trim() || (existing?.currency ?? "USD");
      editingPaymentMethodFlow.delete(userId);
      const ok = await updateAndSavePaymentMethod(editingPm.id, editingPm.description, editingPm.account, currency);
      await ctx.reply(
        ok
          ? `✅ *Forma de pago actualizada*\n\n📌 ${editingPm.description}\n💳 ${editingPm.account}\n🌐 ${currency}`
          : "❌ No se encontró la forma de pago.",
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("◀️ Volver a Formas de pago", "admin_pm_open"),
        }
      );
      return true;
    }
  }

  // ─── Actualizar Sorteo Hoy ───────────────────────────────────────────────
  const updatingHoy = updatingHoyFlow.get(userId);
  if (updatingHoy) {
    const cancelKb = new InlineKeyboard().text("◀️ Cancelar", "security_open");
    const periodLabel = updatingHoy.period === "m" ? "☀️ Mediodía" : "🌙 Noche";

    if (updatingHoy.step === "input_p3") {
      const p3 = text.trim();
      updatingHoyFlow.set(userId, { ...updatingHoy, step: "input_p4", p3 });
      await ctx.reply(`🎯 *${periodLabel}*\n\nIntroduce los 4 dígitos de *Pick 4* (ej: 1234). Escribe \`-\` o \`null\` si no hay.`, { parse_mode: "Markdown", reply_markup: cancelKb });
      return true;
    }

    if (updatingHoy.step === "input_p4") {
      const p4 = text.trim();
      updatingHoyFlow.delete(userId);
      
      const cleanNull = (v: string) => (v === "-" || v.toLowerCase() === "null") ? "" : v;
      const currentHoy = getHoyResult();
      
      const p3Val = cleanNull(updatingHoy.p3 || "");
      const p4Val = cleanNull(p4);
      
      // Actualizamos solo el periodo seleccionado
      if (updatingHoy.period === "m") {
        currentHoy.p3_m = p3Val;
        currentHoy.p4_m = p4Val;
      } else {
        currentHoy.p3_e = p3Val;
        currentHoy.p4_e = p4Val;
      }
      
      saveHoyResult(currentHoy);
      
      await ctx.reply(`✅ *${periodLabel} Actualizado*\n\nEnviando notificación masiva...`, { parse_mode: "Markdown" });

      // Neuromarketing Hit Detection for the new result
      const winningHits = await findWinningStrategies(
        { getP3Map: deps.getP3Map, getP4Map: deps.getP4Map },
        deps.getHotThresholdDays()
      );

      const periodKeyP3 = updatingHoy.period === "m" ? "p3_m" : "p3_e";
      const periodKeyP4 = updatingHoy.period === "m" ? "p4_m" : "p4_e";
      const hitsP3 = winningHits[periodKeyP3];
      const hitsP4 = winningHits[periodKeyP4];

      const formatHits = (hits: { id: string, label: string }[]) => {
        if (hits.length === 0) return `\n🏆 *Ganó:* _Ninguno_`;
        const uniqueLabels = [...new Set(hits.map(h => escapeMd(deps.getExtraMenuLabel(h.label) || h.label)))];
        return `\n🏆 *Ganó:* ${uniqueLabels.join(", ")}`;
      };

      const allowed = getAllowedUsers();
      let sentCount = 0;
      let notification = `🔔 *Nuevo Resultado: ${periodLabel}*\n\n`;
      if (p3Val) notification += `🎯 Pick 3: *${p3Val}*${formatHits(hitsP3)}\n\n`;
      if (p4Val) notification += `🎲 Pick 4: *${p4Val}*${formatHits(hitsP4)}\n`;
      notification += "\nConsulta todos los detalles en *Fijo/Corrido Hoy*.";

      if (p3Val || p4Val) {
        for (const uid of allowed) {
          try {
            await ctx.api.sendMessage(uid, notification, {
              parse_mode: "Markdown",
              reply_markup: deps.buildMainKeyboard(uid)
            });
            sentCount++;
          } catch(e) { /* ignore */ }
        }
      }
      
      await ctx.reply(`📣 Notificación enviada a ${sentCount} usuarios.`, { reply_markup: buildSecurityKeyboard() });
      return true;
    }
  }

  // ─── Generar Candidatos Cache ───────────────────────────────────────────
  const generatingCache = generatingCacheFlow.get(userId);
  if (generatingCache) {
    const limit = parseInt(text, 10);
    if (Number.isNaN(limit) || limit <= 0) {
      await ctx.reply("❌ Por favor, envía un número válido (ej: 20).", {
         reply_markup: new InlineKeyboard().text("◀️ Cancelar", "security_open")
      });
      return true;
    }

    generatingCacheFlow.delete(userId);
    await ctx.reply(`💎 *Iniciando generación de caché APEX...*\n\nLímite: ${limit} candidatos por estrategia.\n\n⏳ _Este proceso puede tardar unos segundos..._`, { parse_mode: "Markdown" });

    try {
      await warmUpCandidateCache({ getP3Map: deps.getP3Map, getP4Map: deps.getP4Map }, limit);
      await ctx.reply("✅ *Caché APEX Generado*\n\nTodas las estrategias han sido pre-calculadas y están listas para latencia cero.", {
        parse_mode: "Markdown",
        reply_markup: buildSecurityKeyboard()
      });
    } catch (e) {
      console.error("[cache] Error en generación manual:", e);
      await ctx.reply("❌ *Error al generar caché*\n\nOcurrió un error inesperado al procesar las estrategias. Revisa los logs.", {
        reply_markup: buildSecurityKeyboard()
      });
    }
    return true;
  }

  return false;
}
