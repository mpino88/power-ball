/**
 * Middleware de restricción de acceso: solo dueño y usuarios en whitelist pueden usar el bot.
 * Los no autorizados ven los planes con 4 botones de temporalidad cada uno.
 * Los usuarios con plan caducado ven un mensaje de caducidad y solo pueden ver la Ayuda o renovar.
 */

import { InlineKeyboard, Keyboard } from "grammy";
import type { getOwnerId as GetOwnerId, isAllowed as IsAllowed } from "../user-config.js";
import { addPlanRequest, requestPlanRenewal, assignPlanToUser, getPlanTemporality, hasUsedTrial, isPlanExpired, refreshIfStale, saveLead, getOwnerIds, isRegistered, getUsername, getPhone, expireUserPlan } from "../user-config.js";
import { getPlans, getPriceForTemporality, formatPlanPrice, REGULAR_TEMPORALITIES, TEMPORALITIES, TRIAL_TEMPORALITIES } from "../plans.js";
import { getPaymentMethods, loadPaymentMethodsFromDB } from "../payment-methods.js";

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
   * - Planes normales: botón de trial (7d, auto-aprobado) + temporalidades regulares de 2 en 2. */
  function addPlanTemporalityButtons(kb: InlineKeyboard, planId: string, planTitle: string, plan: ReturnType<typeof getPlans>[number], prefix: string): void {
    if (plan.autoApprove) {
      kb.text(`✅ Activar gratis — 7 Días`, `${prefix}${planId}_7d`).row();
      return;
    }
    // Botón de trial (7d) — siempre auto-aprobado
    kb.text(`✅ Trial gratis — 7 Días`, `${prefix}${planId}_7d`).row();
    // Temporalidades regulares de 2 en 2
    const temps = REGULAR_TEMPORALITIES;
    for (let i = 0; i < temps.length; i++) {
      const t = temps[i]!;
      const price = getPriceForTemporality(plan, t.id);
      const priceLabel = price ? ` — ${formatPlanPrice(price)}` : "";
      kb.text(`${t.label}${priceLabel}`, `${prefix}${planId}_${t.id}`);
      if (i % 2 === 1) kb.row();
    }
    if (temps.length % 2 !== 0) kb.row();
  }

  async function processPlanSubmission(ctx: any, uid: number, planId: string, planName: string, temporality: string, name: string, phone: string, pendingPlanType: "plan_requested" | "renewal_requested") {
    try {
      const plan = getPlans().find((p) => p.id === planId);
      const isTrial = plan?.autoApprove || temporality === "7d";
      saveLead(uid, name, phone, planName, temporality, isTrial ? "trial_active" : pendingPlanType).catch(() => { });
      if (isTrial) {
        await assignPlanToUser(uid, planName, plan?.menuIds ?? [], temporality, name, phone);
        await ctx.reply(
          `✅ *Plan ${planName} activado*\n\nTu acceso de prueba está listo por *7 días*.`,
          { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
        );
        await ctx.reply("Selecciona una opción:", { reply_markup: options.buildMainKeyboard(uid) });
      } else {
        await requestPlanRenewal(uid, planName, { name, phone, temporality: temporality });
        const ownerIds = getOwnerIds().filter((id) => id !== uid);
        if (ownerIds.length > 0) {
          const ctxApi = (ctx as { api?: { sendMessage?: (id: number, txt: string, opts?: object) => Promise<unknown> } }).api;
          const tLabel = TEMPORALITIES.find((t) => t.id === temporality)?.label ?? temporality;
          const titleType = pendingPlanType === "renewal_requested" ? "Solicitud de plan (renovación)" : "Solicitud de plan";
          const adminPushMsg = `🔔 *${titleType}*\n\nUsuario: \`${uid}\` — ${name}\nPlan: *${planName}* (${tLabel})\nTeléfono: \`${phone}\``;
          const adminKb = new InlineKeyboard()
            .text("✅ Aprobar", `admin_plans_approve_${uid}`)
            .text("❌ Rechazar", `admin_plans_reject_${uid}`)
            .row()
            .url("📩 Contactar Usuario", `tg://openmessage?user_id=${uid}`);
          for (const oid of ownerIds) {
            ctxApi?.sendMessage?.(oid, adminPushMsg, { parse_mode: "Markdown", reply_markup: adminKb }).catch(() => {});
          }
        }

        if (pendingPlanType === "renewal_requested") {
          await ctx.reply(
            `✅ Solicitud de renovación registrada (*${planName}*). El administrador activará tu acceso.`,
            { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
          );
        } else {
          const tLabel = TEMPORALITIES.find((t) => t.id === temporality)?.label ?? temporality;
          await loadPaymentMethodsFromDB();
          const pms = getPaymentMethods();
          const pmLines = pms.map((p, i) => `${i + 1}. *${p.description}*\n   💳 \`${p.account}\` · 🌐 ${p.currency}`);
          const ownerId2 = options.getOwnerId();
          const contactMsg = ownerId2 ? `\n\n[📩 Contactar al administrador](tg://user?id=${ownerId2})` : "";
          const message = `✅ Solicitud registrada (*${planName}* — ${tLabel}). El administrador revisará tu acceso.` + contactMsg;
          await ctx.reply(message, { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } });
          
          if (pms.length > 0) {
            const pmText = `💳 *Formas de pago disponibles:*\n\n` + pmLines.join("\n\n");
            const pmKb = new InlineKeyboard();
            for (const pm of pms) {
              pmKb.copyText(`📋 ${pm.description}`, pm.account).row();
            }
            await ctx.reply(pmText, { parse_mode: "Markdown", reply_markup: pmKb });
          }
        }
      }
    } catch (e) {
      console.error("[middleware] Error processing plan request:", e);
      await ctx.reply("No se pudo guardar la solicitud. Intenta más tarde.", { reply_markup: { remove_keyboard: true } }).catch(() => { });
    }
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

    // ── Verificar caché: recargar desde Sheet si tiene > 3 min de antigüedad ─
    await refreshIfStale();

    const data = ctx.callbackQuery?.data;
    const isOpenAccessAction =
      data === "ver_planes_open" ||
      data === "register_open" ||
      data?.startsWith("request_plan_") ||
      (ctx.message && pendingPlanRequest.has(uid));

    if (!isOpenAccessAction) {
      // ── Dueño: siempre pasa ──────────────────────────────────────────────────
      if (isOwner(uid)) return next();

      // ── Usuario autorizado: verificar caducidad ──────────────────────────────
      if (isAllowed(uid)) {
        if (!isPlanExpired(uid)) return next();

        // Plan caducado: despojar acceso inmediatamente
        // Esto lo hará pasar a ser un usuario sin plan (acceso abierto)
        // para futuros mensajes, pero procesaremos la notificación ahora mismo.
        const wasTrial = getPlanTemporality(uid) === "7d";
        await expireUserPlan(uid);

        const expiryMsg = wasTrial
          ? "⏳ *Tu acceso de prueba (Trial 7 Días) ha expirado*\n\n" +
            "El periodo gratuito ha terminado. Para seguir disfrutando de todas las funciones, elige uno de nuestros planes:\n\n" +
            "_Selecciona el plan y la duración que prefieras:_"
          : "⏰ *Tu plan ha caducado*\n\n" +
            "Ya no tienes acceso al bot. Para seguir usando todas las funciones, renueva tu plan.\n\n" +
            "_Elige el plan y la temporalidad que deseas renovar:_";

        // Dejar que el usuario vuelva al flujo principal de Ver Planes en su próximo tap:
        const kb = new InlineKeyboard()
          .text("📋 Ver Planes", "ver_planes_open").row()
          .text("❓ Ayuda", "help");
        
        const raw = requestAccessLink;
        if (raw) {
          const link = raw.startsWith("http") ? raw : "https://t.me/" + raw.replace(/^t\.me\/?/i, "");
          kb.row().url("📩 Contactar al administrador", link);
        } else if (ownerId !== null) {
          kb.row().url("📩 Contactar al administrador", `tg://user?id=${ownerId}`);
        }

        if (ctx.callbackQuery) await ctx.answerCallbackQuery?.().catch(() => {});
        try {
          await ctx.reply(expiryMsg, { parse_mode: "Markdown", reply_markup: kb });
        } catch (e) {
          console.error("[middleware] Error al mostrar mensaje de caducidad:", (e as Error)?.message ?? e);
        }
        return;
      }
    }

    // ── Usuario NO autorizado (nuevo flujo: acceso abierto con gating) ────────
    
    // Si viene de un link de referido, registrar antes de continuar
    const textOriginal = ctx.message?.text?.trim() ?? "";
    if (textOriginal.startsWith("/start ref_")) {
      const referrerId = parseInt(textOriginal.replace("/start ref_", ""), 10);
      if (!isNaN(referrerId) && referrerId !== uid) {
         import("../referrals.js").then(m => m.registerReferral(referrerId, uid)).catch(console.error);
         console.log(`[Referrals] Usuario nuevo ${uid} invitado por ${referrerId}`);
      }
    }

    // ── Registro: compartir contacto ──────────────────────────────────────────
    if (data === "register_open") {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery?.().catch(() => { });
      await ctx.reply(
        "📞 *Registrarme en Ball Bot*\n\n" +
        "Para completar tu registro necesitamos tu número de contacto.\n\n" +
        "Toca el botón de abajo — Telegram te pedirá tu consentimiento antes de compartirlo.",
        { parse_mode: "Markdown", reply_markup: contactRequestKb("Registrarme") }
      );
      return;
    }

    // Contacto recibido: registro (sin plan pendiente) o plan pendiente
    const pending = ctx.message ? pendingPlanRequest.get(uid) : undefined;
    const contact = ctx.message?.contact;

    if (contact && !pending) {
      // Registro simple (sin plan seleccionado): guardar nombre + teléfono
      const phone = contact.phone_number;
      const name =
        [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() ||
        [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ").trim() ||
        "—";
      try {
        const { saveUserContact } = await import("../user-config.js");
        await saveUserContact(uid, name, phone);
        saveLead(uid, name, phone, "", "", "registered").catch(() => { });
        await ctx.reply(
          "✅ *¡Registro completado!*\n\n" +
          `Bienvenido, *${name}*. Ya puedes explorar el bot.\n\n` +
          "Para acceder a todas las estrategias y funciones avanzadas, elige un plan:",
          { parse_mode: "Markdown", reply_markup: { remove_keyboard: true } }
        );
        // Mostrar menú principal
        await ctx.reply("Selecciona una opción:", { reply_markup: options.buildMainKeyboard(uid) });
      } catch {
        await ctx.reply("No se pudo completar el registro. Intenta más tarde.", {
          reply_markup: { remove_keyboard: true },
        }).catch(() => { });
      }
      return;
    }

    // Cancelar registro (teclado personalizado)
    if (ctx.message?.text?.trim() === "❌ Cancelar" && !pending) {
      await ctx.reply("Registro cancelado. Puedes registrarte cuando quieras.", { reply_markup: { remove_keyboard: true } });
      return;
    }

    // ── Solicitud de plan (request_plan_) ────────────────────────────────────
    if (data?.startsWith("request_plan_")) {
      const rest = data.slice("request_plan_".length);
      const lastUnderscore = rest.lastIndexOf("_");
      if (lastUnderscore > 0) {
        const planId = rest.slice(0, lastUnderscore);
        const temporality = rest.slice(lastUnderscore + 1);
        const plan = getPlans().find((p) => p.id === planId);
        if (plan && TEMPORALITIES.some((t) => t.id === temporality)) {
          if (ctx.callbackQuery) await ctx.answerCallbackQuery?.().catch(() => { });
          if (plan.autoApprove || temporality === "7d") {
            if (await hasUsedTrial(uid)) {
              if (ctx.callbackQuery) await ctx.answerCallbackQuery?.({ text: "Ya usaste tu trial gratuito." }).catch(() => { });
              await ctx.reply(
                "⚠️ *Ya usaste tu acceso de prueba*\n\nEl plan Trial solo puede activarse una vez por usuario. Elige un plan de pago para continuar.",
                { parse_mode: "Markdown", reply_markup: options.buildMainKeyboard(uid) }
              );
              return;
            }
            // Trial/autoApprove: pedir teléfono antes de activar
            const tLabel = TEMPORALITIES.find((t) => t.id === temporality)?.label ?? temporality;
            pendingPlanRequest.set(uid, { planId, planName: plan.title, temporality });
            await ctx.reply(
              `📋 Plan *${plan.title}* — ${tLabel}\n\n` +
              "Para activar tu acceso gratuito necesitamos tu número de contacto.\n\n" +
              "Toca el botón de abajo — Telegram te pedirá tu consentimiento antes de compartirlo.",
              { parse_mode: "Markdown", reply_markup: contactRequestKb(`${plan.title} (${tLabel})`) }
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
      if (ctx.callbackQuery) await ctx.answerCallbackQuery?.({ text: "Plan no encontrado." }).catch(() => { });
      return;
    }

    // ── Contacto para plan pendiente ─────────────────────────────────────────
    if (pending) {
      if (contact) {
        const phone = contact.phone_number;
        const name =
          [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() ||
          [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(" ").trim() ||
          "—";
        pendingPlanRequest.delete(uid);
        await processPlanSubmission(ctx, uid, pending.planId, pending.planName, pending.temporality, name, phone, "plan_requested");
        return;
      }

      const text = ctx.message?.text?.trim() ?? "";
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

    // ── Ver Planes (callback desde menú principal o estrategias) ─────────────
    if (data === "ver_planes_open") {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery?.().catch(() => { });
      // Sincronizar precios desde Sheet
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
            const autoTag = p.autoApprove ? " — _acceso inmediato_" : "";
            return (
              `*${p.title}*${autoTag}\n` +
              `_${p.description.replace(/\n/g, " ")}_`
            );
          })
          .join("\n\n─────────────\n\n");
        msg =
          "📋 *Elige un plan y solicita acceso*\n\n" +
          planList +
          "\n\n👇 _Selecciona la duración y toca el botón:_";
      }

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
      keyboard.row().text("◀️ Volver", "volver");

      // Intentar editar el mensaje actual (si viene de un callback)
      const ctxEdit = ctx as {
        editMessageText?: (text: string, opts?: object) => Promise<unknown>;
        editMessageCaption?: (opts: { caption?: string; parse_mode?: string; reply_markup?: unknown }) => Promise<unknown>;
      };
      if (ctxEdit.editMessageText) {
        try {
          await ctxEdit.editMessageText(msg, { parse_mode: "Markdown", reply_markup: keyboard });
          return;
        } catch (e) {
          if ((e as Error).message?.includes("message is not modified")) return;
          // Fallback: intentar editarCaption (si el mensaje original era foto)
        }
      }
      if (ctxEdit.editMessageCaption) {
        const caption = msg.length > 1024 ? msg.slice(0, 1021) + "…" : msg;
        try {
          await ctxEdit.editMessageCaption({
            caption,
            parse_mode: "Markdown",
            reply_markup: keyboard,
          });
          return;
        } catch (e) {
          if ((e as Error).message?.includes("message is not modified")) return;
          console.error("[middleware] Error al editar caption de planes:", e);
        }
      }
      // Fallback: nuevo mensaje
      await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: keyboard });
      return;
    }

    // ── ACCESO ABIERTO: dejar pasar al bot handler principal ────────────────
    // Todos los usuarios (registrados o no, con o sin plan) pueden ver el menú
    // principal y navegar. El gating se aplica selectivamente en bot.ts.
    return next();
  };
}
