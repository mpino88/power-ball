/**
 * Middleware de restricción de acceso: solo dueño y usuarios en whitelist pueden usar el bot.
 * Los no autorizados reciben un mensaje con su ID y opción de contactar al dueño.
 */

import { InlineKeyboard } from "grammy";
import type { getOwnerId as GetOwnerId, isAllowed as IsAllowed } from "../user-config.js";

export type BuildMainKeyboard = (userId: number | undefined) => InlineKeyboard;

export interface RestrictMiddlewareOptions {
  getOwnerId: typeof GetOwnerId;
  isAllowed: typeof IsAllowed;
  requestAccessLink: string;
  buildMainKeyboard: BuildMainKeyboard;
}

export function createRestrictMiddleware(options: RestrictMiddlewareOptions) {
  const { getOwnerId, isAllowed, requestAccessLink, buildMainKeyboard } = options;

  return async (ctx: { from?: { id: number }; reply: (text: string, opts?: object) => Promise<unknown> }, next: () => Promise<void>) => {
    const uid = ctx.from?.id;
    if (uid === undefined) return next();
    const ownerId = getOwnerId();
    if (ownerId === null) return next();
    if (isAllowed(uid)) return next();

    const raw = requestAccessLink;
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
  };
}
