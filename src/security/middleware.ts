/**
 * Middleware de restricción de acceso: solo dueño y usuarios en whitelist pueden usar el bot.
 * Los no autorizados ven los planes; al hacer clic se registra la solicitud en el sheet (E=plan, F=requested).
 */

import { InlineKeyboard, Keyboard } from "grammy";
import type { getOwnerId as GetOwnerId, isAllowed as IsAllowed } from "../user-config.js";
import { addPlanRequest } from "../user-config.js";
import { getPlans, getPlanById } from "../plans.js";

export type BuildMainKeyboard = (userId: number | undefined) => InlineKeyboard;

export interface RestrictMiddlewareOptions {
  getOwnerId: typeof GetOwnerId;
  isAllowed: typeof IsAllowed;
  requestAccessLink: string;
  buildMainKeyboard: BuildMainKeyboard;
  addPlanRequest: typeof addPlanRequest;
}

export function createRestrictMiddleware(options: RestrictMiddlewareOptions) {
  const { getOwnerId, isAllowed, requestAccessLink, addPlanRequest } = options;
  /** Usuario sin acceso que eligió un plan y está pendiente de enviar teléfono. */
  const pendingPlanRequest = new Map<number, { planId: string; planName: string }>();

  const contactRequestKb = (planTitle: string) =>
    new Keyboard()
      .requestContact("📱 Compartir mi número — " + planTitle)
      .row()
      .text("❌ Cancelar")
      .resized()
      .oneTime();

  return async (
    ctx: {
      from?: { id: number; first_name?: string; last_name?: string };
      message?: { text?: string; contact?: { phone_number: string; first_name?: string; last_name?: string; user_id?: number } };
      callbackQuery?: { data?: string };
      answerCallbackQuery?: (opts?: { text?: string }) => Promise<unknown>;
      reply: (text: string, opts?: object) => Promise<unknown>;
    },
    next: () => Promise<void>
  ) => {
    const uid = ctx.from?.id;
    if (uid === undefined) return next();
    const ownerId = getOwnerId();
    if (ownerId === null) return next();
    if (isAllowed(uid)) return next();

    const data = ctx.callbackQuery?.data;
    if (data?.startsWith("request_plan_")) {
      const planId = data.slice("request_plan_".length);
      const plan = getPlanById(planId);
      if (plan) {
        pendingPlanRequest.set(uid, { planId, planName: plan.title });
        if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery();
        await ctx.reply(
          "📋 Plan *" + plan.title + "*\n\n" +
          "Para completar la solicitud necesitamos tu número de contacto.\n\n" +
          "Toca el botón de abajo — Telegram te pedirá tu consentimiento antes de compartirlo.",
          { parse_mode: "Markdown", reply_markup: contactRequestKb(plan.title) }
        );
      } else {
        if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery({ text: "Plan no encontrado." }).catch(() => {});
      }
      return;
    }

    const pending = ctx.message ? pendingPlanRequest.get(uid) : undefined;
    if (pending) {
      const contact = ctx.message?.contact;
      if (contact) {
        const phone = contact.phone_number;
        const name =
          [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() ||
          [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ").trim() ||
          "—";
        pendingPlanRequest.delete(uid);
        try {
          await addPlanRequest(uid, pending.planName, { name, phone });
          await ctx.reply(
            "✅ Solicitud registrada (*" + pending.planName + "*). El administrador revisará tu acceso.",
            { parse_mode: "Markdown", reply_markup: Keyboard.removed() }
          );
        } catch (e) {
          await ctx.reply("No se pudo guardar la solicitud. Intenta más tarde o contacta al administrador.", {
            reply_markup: Keyboard.removed(),
          }).catch(() => {});
        }
        return;
      }

      const text = (ctx.message as { text?: string }).text?.trim() ?? "";
      if (text === "❌ Cancelar") {
        pendingPlanRequest.delete(uid);
        await ctx.reply("Solicitud cancelada.", { reply_markup: Keyboard.removed() });
        return;
      }

      await ctx.reply(
        "⚠️ Para solicitar el plan *" + pending.planName + "* debes compartir tu número usando el botón de abajo.\n\n" +
        "No se aceptan números escritos manualmente.",
        { parse_mode: "Markdown", reply_markup: contactRequestKb(pending.planName) }
      );
      return;
    }

    const raw = requestAccessLink;
    let link = "";
    if (raw) {
      link = raw.startsWith("http") ? raw : "https://t.me/" + raw.replace(/^t\.me\/?/i, "");
    } else if (ownerId !== null) {
      link = `tg://user?id=${ownerId}`;
    }

    const plans = getPlans();
    const header =
      "🔒 *Acceso restringido*\n\n" +
      "Tu ID: `" + uid + "` — elige un plan y solicita acceso.\n\n";
    let body: string;
    if (plans.length === 0) {
      body = "No hay planes configurados. Contacta al administrador para solicitar acceso.";
    } else {
      body =
        plans
          .map((p) => {
            const desc = p.description.replace(/\n/g, " ");
            return (
              "▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃\n" +
              `  *${p.title}*\n` +
              (p.price ? `  *${p.price}*\n` : "") +
              "  ─────────────\n" +
              `  ${desc}\n` +
              "▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃"
            );
          })
          .join("\n\n") +
        "\n\n👇 _Elige tu plan y toca el botón para solicitar:_";
    }
    const msg = link ? header + body : "🔒 *Acceso restringido.*\n\nNo se pudo generar el enlace para solicitar acceso. Contacta al administrador y envíale tu ID: `" + uid + "`.";

    const keyboard = new InlineKeyboard();
    if (plans.length === 0 && link) {
      keyboard.url("📩 Solicitar acceso", link);
    } else {
      for (const p of plans) {
        keyboard.text(`  ✓ ${p.title}  ·  ${p.price}  ·  Solicitar  `, `request_plan_${p.id}`).row();
      }
      if (link) keyboard.url("📩 Contactar al administrador", link);
    }

    await ctx.reply(msg, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  };
}
