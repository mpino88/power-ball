/**
 * Middleware de restricción de acceso: solo dueño y usuarios en whitelist pueden usar el bot.
 * Los no autorizados ven los planes con 4 botones de temporalidad cada uno.
 * Los usuarios con plan caducado ven un mensaje de caducidad y solo pueden ver la Ayuda o renovar.
 */

import { InlineKeyboard, Keyboard } from "grammy";
import type { getOwnerId as GetOwnerId, isAllowed as IsAllowed } from "../user-config.js";
import { addPlanRequest, isPlanExpired } from "../user-config.js";
import { getPlans, getPriceForTemporality, TEMPORALITIES } from "../plans.js";

export type BuildMainKeyboard = (userId: number | undefined) => InlineKeyboard;

export interface RestrictMiddlewareOptions {
  getOwnerId: typeof GetOwnerId;
  isAllowed: typeof IsAllowed;
  requestAccessLink: string;
  buildMainKeyboard: BuildMainKeyboard;
  addPlanRequest: typeof addPlanRequest;
  isOwner: (userId: number) => boolean;
}

export function createRestrictMiddleware(options: RestrictMiddlewareOptions) {
  const { getOwnerId, isAllowed, requestAccessLink, isOwner } = options;

  /** Usuario sin acceso que eligió un plan+temporalidad y está pendiente de enviar teléfono. */
  const pendingPlanRequest = new Map<number, { planId: string; planName: string; temporality: string }>();
  /** Usuario con plan caducado que eligió un plan+temporalidad para renovar. */
  const pendingRenewal = new Map<number, { planId: string; planName: string; temporality: string }>();

  const contactRequestKb = (label: string) =>
    new Keyboard()
      .requestContact("📱 Compartir mi número — " + label)
      .row()
      .text("❌ Cancelar")
      .resized()
      .oneTime();

  /** Construye los 4 botones de temporalidad de un plan. */
  function addPlanTemporalityButtons(kb: InlineKeyboard, planId: string, planTitle: string, plan: ReturnType<typeof getPlans>[number], prefix: string): void {
    for (const t of TEMPORALITIES) {
      const price = getPriceForTemporality(plan, t.id);
      const priceLabel = price ? ` — ${price}` : "";
      kb.text(`${t.label}${priceLabel}`, `${prefix}${planId}_${t.id}`);
    }
    kb.row();
  }

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

    // ── Dueño: siempre pasa ──────────────────────────────────────────────────
    if (isOwner(uid)) return next();

    // ── Usuario autorizado: verificar caducidad ──────────────────────────────
    if (isAllowed(uid)) {
      if (!isPlanExpired(uid)) return next();

      // Plan caducado — manejar flujo de renovación
      const data = ctx.callbackQuery?.data;

      // Botón de renovar plan (selección de temporalidad)
      if (data?.startsWith("renew_plan_")) {
        const rest = data.slice("renew_plan_".length);
        const lastUnderscore = rest.lastIndexOf("_");
        if (lastUnderscore > 0) {
          const planId = rest.slice(0, lastUnderscore);
          const temporality = rest.slice(lastUnderscore + 1);
          const plan = getPlans().find((p) => p.id === planId);
          if (plan && TEMPORALITIES.some((t) => t.id === temporality)) {
            pendingRenewal.set(uid, { planId, planName: plan.title, temporality });
            if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery();
            const tLabel = TEMPORALITIES.find((t) => t.id === temporality)?.label ?? temporality;
            await ctx.reply(
              `🔄 *Renovar plan: ${plan.title}* (${tLabel})\n\n` +
              "Para completar la renovación necesitamos tu número de contacto.\n\n" +
              "Toca el botón de abajo — Telegram te pedirá tu consentimiento antes de compartirlo.",
              { parse_mode: "Markdown", reply_markup: contactRequestKb(`${plan.title} (${tLabel})`) }
            );
            return;
          }
        }
        if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery({ text: "Plan no encontrado." }).catch(() => {});
        return;
      }

      // Solo "help" pasa cuando el plan está caducado
      if (data === "help") return next();

      // Contacto para renovación
      const renewal = ctx.message ? pendingRenewal.get(uid) : undefined;
      if (renewal) {
        const contact = ctx.message?.contact;
        if (contact) {
          const phone = contact.phone_number;
          const name =
            [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() ||
            [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ").trim() ||
            "—";
          pendingRenewal.delete(uid);
          try {
            await addPlanRequest(uid, renewal.planName, { name, phone, temporality: renewal.temporality });
            await ctx.reply(
              `✅ Solicitud de renovación registrada (*${renewal.planName}*). El administrador activará tu acceso.`,
              { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
            );
          } catch {
            await ctx.reply("No se pudo guardar la solicitud. Intenta más tarde.", {
              reply_markup: { remove_keyboard: true },
            }).catch(() => {});
          }
          return;
        }

        const text = (ctx.message as { text?: string }).text?.trim() ?? "";
        if (text === "❌ Cancelar") {
          pendingRenewal.delete(uid);
          await ctx.reply("Renovación cancelada.", { reply_markup: { remove_keyboard: true } });
          return;
        }
        const t = TEMPORALITIES.find((t) => t.id === renewal.temporality);
        await ctx.reply(
          `⚠️ Para renovar el plan *${renewal.planName}* (${t?.label ?? renewal.temporality}) debes compartir tu número usando el botón de abajo.`,
          { parse_mode: "Markdown", reply_markup: contactRequestKb(`${renewal.planName} (${t?.label ?? renewal.temporality})`) }
        );
        return;
      }

      // Mostrar mensaje de caducidad
      const plans = getPlans();
      let link = "";
      const raw = requestAccessLink;
      if (raw) {
        link = raw.startsWith("http") ? raw : "https://t.me/" + raw.replace(/^t\.me\/?/i, "");
      } else if (ownerId !== null) {
        link = `tg://user?id=${ownerId}`;
      }

      const expiryMsg =
        "⏰ *Tu plan ha caducado*\n\n" +
        "Ya no tienes acceso al bot. Para seguir usando todas las funciones, renueva tu plan.\n\n" +
        "_Elige el plan y la temporalidad que deseas renovar:_";

      const kb = new InlineKeyboard();
      for (const p of plans) {
        kb.text(`📋 ${p.title}`, `noop`).row();
        addPlanTemporalityButtons(kb, p.id, p.title, p, "renew_plan_");
      }
      kb.text("❓ Ayuda", "help");
      if (link) kb.row().url("📩 Contactar al administrador", link);

      if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      await ctx.reply(expiryMsg, { parse_mode: "Markdown", reply_markup: kb });
      return;
    }

    // ── Usuario NO autorizado ──────────────────────────────────────────────────
    const data = ctx.callbackQuery?.data;
    if (data?.startsWith("request_plan_")) {
      const rest = data.slice("request_plan_".length);
      const lastUnderscore = rest.lastIndexOf("_");
      if (lastUnderscore > 0) {
        const planId = rest.slice(0, lastUnderscore);
        const temporality = rest.slice(lastUnderscore + 1);
        const plan = getPlans().find((p) => p.id === planId);
        if (plan && TEMPORALITIES.some((t) => t.id === temporality)) {
          pendingPlanRequest.set(uid, { planId, planName: plan.title, temporality });
          if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery();
          const tLabel = TEMPORALITIES.find((t) => t.id === temporality)?.label ?? temporality;
          await ctx.reply(
            `📋 Plan *${plan.title}* — ${tLabel}\n\n` +
            "Para completar la solicitud necesitamos tu número de contacto.\n\n" +
            "Toca el botón de abajo — Telegram te pedirá tu consentimiento antes de compartirlo.",
            { parse_mode: "Markdown", reply_markup: contactRequestKb(`${plan.title} (${tLabel})`) }
          );
          return;
        }
      }
      if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery({ text: "Plan no encontrado." }).catch(() => {});
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
          await addPlanRequest(uid, pending.planName, { name, phone, temporality: pending.temporality });
          const tLabel = TEMPORALITIES.find((t) => t.id === pending.temporality)?.label ?? pending.temporality;
          await ctx.reply(
            `✅ Solicitud registrada (*${pending.planName}* — ${tLabel}). El administrador revisará tu acceso.`,
            { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
          );
        } catch {
          await ctx.reply("No se pudo guardar la solicitud. Intenta más tarde o contacta al administrador.", {
            reply_markup: { remove_keyboard: true },
          }).catch(() => {});
        }
        return;
      }

      const text = (ctx.message as { text?: string }).text?.trim() ?? "";
      if (text === "❌ Cancelar") {
        pendingPlanRequest.delete(uid);
        await ctx.reply("Solicitud cancelada.", { reply_markup: { remove_keyboard: true } });
        return;
      }

      const t = TEMPORALITIES.find((t) => t.id === pending.temporality);
      await ctx.reply(
        `⚠️ Para solicitar el plan *${pending.planName}* (${t?.label ?? pending.temporality}) debes compartir tu número usando el botón de abajo.\n\nNo se aceptan números escritos manualmente.`,
        { parse_mode: "Markdown", reply_markup: contactRequestKb(`${pending.planName} (${t?.label ?? pending.temporality})`) }
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
            const prices = TEMPORALITIES
              .map((t) => {
                const price = getPriceForTemporality(p, t.id);
                return price ? `${t.label}: *${price}*` : null;
              })
              .filter(Boolean)
              .join(" · ");
            return (
              "▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃\n" +
              `  *${p.title}*\n` +
              (prices ? `  ${prices}\n` : "") +
              "  ─────────────\n" +
              `  ${desc}\n` +
              "▃▃▃▃▃▃▃▃▃▃▃▃▃▃▃"
            );
          })
          .join("\n\n") +
        "\n\n👇 _Elige tu plan, selecciona la duración y toca el botón para solicitar:_";
    }

    const msg = link
      ? header + body
      : "🔒 *Acceso restringido.*\n\nContacta al administrador y envíale tu ID: `" + uid + "`.";

    const keyboard = new InlineKeyboard();
    if (plans.length === 0 && link) {
      keyboard.url("📩 Solicitar acceso", link);
    } else {
      for (const p of plans) {
        keyboard.text(`📋 ${p.title}`, `noop_plan`).row();
        addPlanTemporalityButtons(keyboard, p.id, p.title, p, "request_plan_");
      }
      if (link) keyboard.url("📩 Contactar al administrador", link);
    }

    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
  };
}
