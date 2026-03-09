/**
 * Middleware de restricción de acceso: solo dueño y usuarios en whitelist pueden usar el bot.
 * Los no autorizados ven los planes con 4 botones de temporalidad cada uno.
 * Los usuarios con plan caducado ven un mensaje de caducidad y solo pueden ver la Ayuda o renovar.
 */

import { InlineKeyboard, Keyboard } from "grammy";
import type { getOwnerId as GetOwnerId, isAllowed as IsAllowed } from "../user-config.js";
import { addPlanRequest, assignPlanToUser, hasUsedTrial, isPlanExpired, refreshIfStale } from "../user-config.js";
import { getPlans, getPriceForTemporality, REGULAR_TEMPORALITIES, TEMPORALITIES, TRIAL_TEMPORALITIES } from "../plans.js";

export type BuildMainKeyboard = (userId: number | undefined) => InlineKeyboard;

export interface RestrictMiddlewareOptions {
  getOwnerId: typeof GetOwnerId;
  isAllowed: typeof IsAllowed;
  requestAccessLink: string;
  buildMainKeyboard: BuildMainKeyboard;
  addPlanRequest: typeof addPlanRequest;
  isOwner: (userId: number) => boolean;
  /**
   * Devuelve la foto de onboarding para mostrarla encima de los planes al nuevo usuario.
   * Puede retornar un file_id de Telegram (string) o un InputFile de grammY (opaco aquí como unknown).
   * Si retorna undefined o no se provee, se usa ctx.reply (solo texto).
   */
  getOnboardingPhoto?: () => unknown;
  /** Se invoca tras el primer envío de la imagen para cachear su file_id. */
  onOnboardingPhotoSent?: (fileId: string) => void;
  /**
   * Si se provee, se llama antes de mostrar cualquier menú de planes para garantizar
   * que los precios estén sincronizados con el Sheet.
   * Debe implementar su propio TTL para evitar llamadas excesivas.
   */
  reloadPlans?: () => Promise<void>;
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

  /** Construye los botones de temporalidad de un plan.
   * - Planes autoApprove: un solo botón "✅ Activar gratis".
   * - Planes normales: botón de trial (1d, auto-aprobado) + temporalidades regulares de 2 en 2. */
  function addPlanTemporalityButtons(kb: InlineKeyboard, planId: string, planTitle: string, plan: ReturnType<typeof getPlans>[number], prefix: string): void {
    if (plan.autoApprove) {
      kb.text(`✅ Activar gratis — 1 Día`, `${prefix}${planId}_1d`).row();
      return;
    }
    // Botón de trial (1d) — siempre auto-aprobado
    kb.text(`✅ Trial gratis — 1 Día`, `${prefix}${planId}_1d`).row();
    // Temporalidades regulares de 2 en 2
    const temps = REGULAR_TEMPORALITIES;
    for (let i = 0; i < temps.length; i++) {
      const t = temps[i]!;
      const price = getPriceForTemporality(plan, t.id);
      const priceLabel = price ? ` — ${price}` : "";
      kb.text(`${t.label}${priceLabel}`, `${prefix}${planId}_${t.id}`);
      if (i % 2 === 1) kb.row();
    }
    if (temps.length % 2 !== 0) kb.row();
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

    // ── Verificar caché: recargar desde Sheet si tiene > 3 min de antigüedad ─
    await refreshIfStale();

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
            if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery();
            if (plan.autoApprove || temporality === "1d") {
              if (hasUsedTrial(uid)) {
                if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery({ text: "Ya usaste tu trial gratuito." }).catch(() => {});
                await ctx.reply(
                  "⚠️ *Ya usaste tu acceso de prueba*\n\nEl plan Trial solo puede activarse una vez por usuario. Elige un plan de pago para continuar.",
                  { parse_mode: "Markdown" }
                );
                return;
              }
              await assignPlanToUser(uid, plan.title, plan.menuIds ?? [], temporality);
              await ctx.reply(
                `✅ *Plan ${plan.title} activado*\n\nTu acceso de prueba está listo por *1 día*.`,
                { parse_mode: "Markdown", reply_markup: options.buildMainKeyboard(uid) }
              );
              return;
            }
            const tLabel = TEMPORALITIES.find((t) => t.id === temporality)?.label ?? temporality;
            pendingRenewal.set(uid, { planId, planName: plan.title, temporality });
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

      // Mostrar mensaje de caducidad (sincronizar precios desde Sheet antes de mostrar)
      await options.reloadPlans?.();
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
          if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery();
          if (plan.autoApprove || temporality === "1d") {
            if (hasUsedTrial(uid)) {
              if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery({ text: "Ya usaste tu trial gratuito." }).catch(() => {});
              await ctx.reply(
                "⚠️ *Ya usaste tu acceso de prueba*\n\nEl plan Trial solo puede activarse una vez por usuario. Elige un plan de pago para continuar.",
                { parse_mode: "Markdown", reply_markup: options.buildMainKeyboard(uid) }
              );
              return;
            }
            await assignPlanToUser(uid, plan.title, plan.menuIds ?? [], temporality);
            await ctx.reply(
              `✅ *¡Plan ${plan.title} activado!*\n\nTienes *1 día* de acceso gratuito para explorar todas las funciones. ¡Disfrútalo!`,
              { parse_mode: "Markdown", reply_markup: options.buildMainKeyboard(uid) }
            );
            return;
          }
          const tLabel = TEMPORALITIES.find((t) => t.id === temporality)?.label ?? temporality;
          pendingPlanRequest.set(uid, { planId, planName: plan.title, temporality });
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

    // Sincronizar precios desde Sheet antes de mostrar el menú de planes
    await options.reloadPlans?.();

    const raw = requestAccessLink;
    let link = "";
    if (raw) {
      link = raw.startsWith("http") ? raw : "https://t.me/" + raw.replace(/^t\.me\/?/i, "");
    } else if (ownerId !== null) {
      link = `tg://user?id=${ownerId}`;
    }

    const plans = getPlans();

    let msg: string;
    if (plans.length === 0) {
      msg = "📋 *Elige un plan y solicita acceso*\n\nNo hay planes configurados. Contacta al administrador para solicitar acceso.";
    } else {
      const planList = plans
        .map((p) => {
          const temporalities = p.autoApprove ? TRIAL_TEMPORALITIES : REGULAR_TEMPORALITIES;
          const prices = temporalities
            .map((t) => {
              const price = getPriceForTemporality(p, t.id);
              return price ? `${t.label}: *${price}*` : null;
            })
            .filter(Boolean)
            .join(" · ");
          const autoTag = p.autoApprove ? " — _acceso inmediato_" : "";
          return (
            `*${p.title}*${autoTag}\n` +
            (prices ? `${prices}\n` : "") +
            `_${p.description.replace(/\n/g, " ")}_`
          );
        })
        .join("\n\n─────────────\n\n");
      msg =
        "📋 *Elige un plan y solicita acceso*\n\n" +
        planList +
        "\n\n👇 _Selecciona la duración y toca el botón:_";
    }

    // Teclado completo con botones de selección de plan (usado en el paso 2).
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

    // ── Paso 2: "Ver Planes" — editar caption con info completa + botones ───
    if (data === "ver_planes_open") {
      if (ctx.answerCallbackQuery) await ctx.answerCallbackQuery();
      const ctxEdit = ctx as {
        editMessageCaption?: (caption: string, opts?: object) => Promise<unknown>;
      };
      if (ctxEdit.editMessageCaption) {
        const caption = msg.length > 1024 ? msg.slice(0, 1021) + "…" : msg;
        try {
          await ctxEdit.editMessageCaption(caption, {
            parse_mode: "Markdown",
            reply_markup: keyboard,
          });
          return;
        } catch (e) {
          if ((e as Error).message?.includes("message is not modified")) return;
          console.error("[middleware] Error al editar caption de planes:", e);
        }
      }
      // Fallback: nuevo mensaje con el contenido completo
      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
      return;
    }

    // ── Paso 1: imagen de onboarding con un solo botón "Ver Planes" ─────────
    const onboardingPhoto = options.getOnboardingPhoto?.();
    const ctxWithPhoto = ctx as {
      replyWithPhoto?: (photo: unknown, opts?: object) => Promise<{ photo?: Array<{ file_id: string }> }>;
    };
    if (ctxWithPhoto.replyWithPhoto && onboardingPhoto !== undefined) {
      const welcomeCaption =
        "🎰 *Power Ball Bot*\n\n" +
        "Tu guía para _Pick 3_ y _Pick 4_ de Florida Lottery\\.\n\n" +
        "_Toca el botón para ver los planes disponibles:_";
      const welcomeKeyboard = new InlineKeyboard().text("📋 Ver Planes", "ver_planes_open");
      try {
        const sentMsg = await ctxWithPhoto.replyWithPhoto(onboardingPhoto, {
          caption: welcomeCaption,
          parse_mode: "MarkdownV2",
          reply_markup: welcomeKeyboard,
        });
        if (typeof onboardingPhoto !== "string" && options.onOnboardingPhotoSent) {
          const photos = sentMsg?.photo;
          if (photos && photos.length > 0) {
            options.onOnboardingPhotoSent(photos[photos.length - 1]!.file_id);
          }
        }
        return;
      } catch (photoErr) {
        console.error("[middleware] Error al enviar foto de onboarding:", photoErr);
        // Fallback: mostrar texto completo con todos los botones.
      }
    }
    await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
  };
}
