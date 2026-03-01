/**
 * Middleware de restricción de acceso: solo dueño y usuarios en whitelist pueden usar el bot.
 * Los no autorizados ven los planes; al hacer clic se registra la solicitud en el sheet (E=plan, F=requested).
 */

import { InlineKeyboard } from "grammy";
import type { getOwnerId as GetOwnerId, isAllowed as IsAllowed } from "../user-config.js";
import type { addPlanRequest as AddPlanRequest } from "../user-config.js";
import { getPlans, getPlanById } from "../plans.js";

export type BuildMainKeyboard = (userId: number | undefined) => InlineKeyboard;

export interface RestrictMiddlewareOptions {
  getOwnerId: typeof GetOwnerId;
  isAllowed: typeof IsAllowed;
  requestAccessLink: string;
  buildMainKeyboard: BuildMainKeyboard;
  addPlanRequest: AddPlanRequest;
}

export function createRestrictMiddleware(options: RestrictMiddlewareOptions) {
  const { getOwnerId, isAllowed, requestAccessLink, addPlanRequest } = options;

  return async (
    ctx: {
      from?: { id: number };
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
        try {
          await addPlanRequest(uid, plan.title);
          if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery({ text: "Solicitud enviada ✓" });
          await ctx.reply(
            "✅ Tu solicitud de acceso ha sido registrada (*" +
              plan.title +
              "*). El administrador la revisará y te dará acceso cuando la apruebe.",
            { parse_mode: "Markdown" }
          );
        } catch (e) {
          if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery({ text: "Error al registrar. Intenta más tarde." }).catch(() => {});
          await ctx.reply("No se pudo registrar la solicitud. Intenta más tarde o contacta al administrador.").catch(() => {});
        }
      } else {
        if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery({ text: "Plan no encontrado." }).catch(() => {});
      }
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
      "Elige un plan y solicita acceso. Tu ID: `" + uid + "` — envíalo al administrador.\n\n";
    let body: string;
    if (plans.length === 0) {
      body = "No hay planes configurados. Contacta al administrador para solicitar acceso.";
    } else {
      body =
        plans
          .map(
            (p) =>
              "━━━━━━━━━━━━━━━━\n" +
              `📋 *${p.title}* — ${p.price}\n` +
              p.description +
              "\n"
          )
          .join("") +
        "━━━━━━━━━━━━━━━━\n\n👇 Elige un plan para solicitar acceso:";
    }
    const msg = link ? header + body : "🔒 *Acceso restringido.*\n\nNo se pudo generar el enlace para solicitar acceso. Contacta al administrador y envíale tu ID: `" + uid + "`.";

    const keyboard = new InlineKeyboard();
    if (plans.length === 0 && link) {
      keyboard.url("📩 Solicitar acceso", link);
    } else {
      for (const p of plans) {
        keyboard.text(`📋 ${p.title} — ${p.price} — Solicitar`, `request_plan_${p.id}`).row();
      }
      if (link) keyboard.url("📩 Contactar al administrador", link);
    }

    await ctx.reply(msg, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  };
}
