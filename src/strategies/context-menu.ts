/**
 * Menú contextual por defecto: base P3/P4 y período Mediodía/Noche.
 * Reutilizable por cualquier estrategia que use el mismo esquema.
 */

import { InlineKeyboard } from "grammy";
import { STRATEGY_CONTEXT_CALLBACK_PREFIX } from "./types.js";

export function buildDefaultContextKeyboard(menuId: string): InlineKeyboard {
  const pre = `${STRATEGY_CONTEXT_CALLBACK_PREFIX}${menuId}_`;
  return new InlineKeyboard()
    .text("P3 (Fijos) ☀️ Mediodía", `${pre}p3_m`)
    .text("P3 (Fijos) 🌙 Noche", `${pre}p3_e`)
    .row()
    .text("P4 (Corridos) ☀️ Mediodía", `${pre}p4_m`)
    .text("P4 (Corridos) 🌙 Noche", `${pre}p4_e`)
    .row()
    .text("◀️ Volver", "volver");
}

export function getDefaultContextMessage(menuLabel: string): string {
  return (
    `📌 *${menuLabel}*\n\n` +
    "Elige la *base de conocimientos* y el *período*:\n\n" +
    "• *P3 (Fijos)* — mapa de fechas Pick 3\n" +
    "• *P4 (Corridos)* — mapa de fechas Pick 4\n" +
    "• ☀️ *Mediodía* (Día) · 🌙 *Noche*"
  );
}
