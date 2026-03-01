/**
 * Teclados de menús: principal, submenú de juego (Hoy/Ayer/Semana/Fecha), estadísticas, días diferencia.
 */

import { InlineKeyboard } from "grammy";
import type { getOwnerId as GetOwnerId, getExtraMenus as GetExtraMenus } from "../user-config.js";
import type {
  getExtraMenuIds as GetExtraMenuIds,
  getExtraMenuLabel as GetExtraMenuLabel,
} from "../menu-registry.js";
import { EXTRA_MENU_CALLBACK_PREFIX } from "../menu-registry.js";
import type { GameMenu } from "./types.js";

export interface MainKeyboardDeps {
  getOwnerId: typeof GetOwnerId;
  getExtraMenus: (userId: number) => string[];
  getExtraMenuIds: typeof GetExtraMenuIds;
  getExtraMenuLabel: typeof GetExtraMenuLabel;
}

/** Callback al pulsar "➕ Estrategias": abre el submenú de estrategias. */
export const ESTRATEGIAS_OPEN_CALLBACK = "estrategias_open";

export function buildMainKeyboard(userId: number | undefined, deps: MainKeyboardDeps): InlineKeyboard {
  const kb = new InlineKeyboard()
    .text("🎯 Fijo (P3)", "menu_fijo")
    .text("🎲 Corrido (P4)", "menu_corrido")
    .row()
    .text("☀️🌙 Ambos (Fijo + Corrido)", "menu_ambos");
  const ownerId = deps.getOwnerId();
  const extraIds = deps.getExtraMenuIds();
  const showExtra = extraIds.filter((id) => {
    if (ownerId === null) return true;
    if (userId === ownerId) return true;
    return deps.getExtraMenus(userId ?? 0).includes(id);
  });
  if (showExtra.length > 0) {
    kb.row().text("➕ Estrategias", ESTRATEGIAS_OPEN_CALLBACK);
  }
  if (ownerId === null || userId !== ownerId) {
    kb.row().text("❓ Ayuda", "help");
    if (ownerId !== null && userId !== ownerId) {
      kb.row().text("📋 Cambiar plan", "cambiar_plan_open");
    }
  }
  if (ownerId !== null && userId === ownerId) {
    kb.row().text("🔒 Seguridad", "security_open");
  }
  return kb;
}

/** Teclado del submenú "➕ Estrategias": lista de menús extra (y custom) para este usuario + Volver. */
export function buildEstrategiasKeyboard(userId: number | undefined, deps: MainKeyboardDeps): InlineKeyboard {
  const ownerId = deps.getOwnerId();
  const extraIds = deps.getExtraMenuIds();
  const showExtra = extraIds.filter((id) => {
    if (ownerId === null) return true;
    if (userId === ownerId) return true;
    return deps.getExtraMenus(userId ?? 0).includes(id);
  });
  const kb = new InlineKeyboard();
  for (const id of showExtra) {
    const label = deps.getExtraMenuLabel(id);
    if (label) kb.text(label, EXTRA_MENU_CALLBACK_PREFIX + id).row();
  }
  kb.row().text("⚙️ Gestionar estrategias", "estrategias_manage");
  kb.text("◀️ Volver", "volver");
  return kb;
}

export function buildSubmenuKeyboard(game: GameMenu): InlineKeyboard {
  const prefix = game === "fijo" ? "fijo" : game === "corrido" ? "corrido" : "ambos";
  return new InlineKeyboard()
    .text("☀️🌙 Hoy", `${prefix}_hoy`)
    .text("☀️🌙 Ayer", `${prefix}_ayer`)
    .row()
    .text("📆 Esta semana", `${prefix}_semana`)
    .row()
    .text("📅 Escoger fecha", `${prefix}_fecha`)
    .row()
    .text("◀️ Volver", "volver");
}

export function buildEstadisticasKeyboard(threshold: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("☀️ Mediodía (M)", "stats_grupos_M")
    .text("🌙 Noche (E)", "stats_grupos_E")
    .row()
    .text(`🔢 Días diferencia: ${threshold}`, "stats_set_days")
    .row()
    .text("◀️ Volver", "volver");
}

export function buildIndividualPeriodKeyboard(threshold: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("☀️ Mediodía (M)", "stats_individual_M")
    .text("🌙 Noche (E)", "stats_individual_E")
    .row()
    .text(`🔢 Días diferencia: ${threshold}`, "stats_individual_set_days")
    .row()
    .text("◀️ Volver", "volver");
}

export function buildDiasDiferenciaKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("1", "stats_days_1")
    .text("3", "stats_days_3")
    .text("5", "stats_days_5")
    .text("7", "stats_days_7")
    .text("10", "stats_days_10")
    .row()
    .text("◀️ Volver", "volver");
}

export function buildDiasDiferenciaKeyboardIndividual(): InlineKeyboard {
  return new InlineKeyboard()
    .text("1", "stats_individual_days_1")
    .text("3", "stats_individual_days_3")
    .text("5", "stats_individual_days_5")
    .text("7", "stats_individual_days_7")
    .text("10", "stats_individual_days_10")
    .row()
    .text("◀️ Volver", "stats_individual_back");
}
