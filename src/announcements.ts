/**
 * Módulo de Anuncios Globales.
 * - Usuarios: banner informativo mostrado antes de cada respuesta si hay anuncios activos.
 * - Admin: CRUD completo (crear, editar, eliminar, limpiar todos).
 * La persistencia (Sheet 7ª pestaña) se gestiona desde user-config.ts.
 */

export {
    loadAnnouncementsFromDB,
    addAnnouncement,
    editAnnouncement,
    deleteAnnouncement,
    clearAllAnnouncements,
    invalidateAnnouncementsCache,
} from "./user-config.js";
export type { AnnouncementRow } from "./user-config.js";

import { InlineKeyboard } from "grammy";
import type { AnnouncementRow } from "./user-config.js";

// ─── Banner de usuario ────────────────────────────────────────────────────────

/**
 * Prepend a todos los mensajes al usuario cuando hay anuncios activos.
 * Retorna "" si no hay anuncios (sin modificar el mensaje).
 */
export function buildAnnouncementsBanner(items: AnnouncementRow[]): string {
    if (items.length === 0) return "";
    const lines = items.map((a) => `📌 ${a.texto}`).join("\n");
    return `📢 *ANUNCIOS*\n${lines}\n\n`;
}

// ─── Teclados admin ───────────────────────────────────────────────────────────

/** Menú principal de Anuncios para el admin. */
export function buildAdminAnnouncementsKeyboard(hasAnnouncements: boolean): InlineKeyboard {
    const kb = new InlineKeyboard()
        .text("➕ Crear anuncio", "admin_ann_create")
        .row();
    if (hasAnnouncements) {
        kb.text("✏️ Editar anuncio", "admin_ann_edit_list")
            .row()
            .text("🗑 Eliminar anuncio", "admin_ann_delete_list")
            .row()
            .text("🧹 Eliminar todos", "admin_ann_clear_confirm")
            .row();
    }
    kb.text("◀️ Volver", "volver");
    return kb;
}

/** Lista de anuncios para editar (un botón por anuncio). */
export function buildAnnouncementsEditListKeyboard(items: AnnouncementRow[]): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const ann of items) {
        const label = ann.texto.length > 40 ? ann.texto.slice(0, 37) + "…" : ann.texto;
        kb.text(`✏️ ${label}`, `admin_ann_edit_pick:${ann.id}`).row();
    }
    kb.text("◀️ Volver", "admin_ann_open");
    return kb;
}

/** Lista de anuncios para eliminar (un botón por anuncio). */
export function buildAnnouncementsDeleteListKeyboard(items: AnnouncementRow[]): InlineKeyboard {
    const kb = new InlineKeyboard();
    for (const ann of items) {
        const label = ann.texto.length > 40 ? ann.texto.slice(0, 37) + "…" : ann.texto;
        kb.text(`🗑 ${label}`, `admin_ann_delete_pick:${ann.id}`).row();
    }
    kb.text("◀️ Volver", "admin_ann_open");
    return kb;
}

// ─── Helpers de texto ─────────────────────────────────────────────────────────

/** Construye el texto del panel de anuncios del admin, mostrando la lista actual. */
export function buildAdminAnnouncementsText(items: AnnouncementRow[]): string {
    if (items.length === 0) {
        return "📢 *Anuncios Globales*\n\nNo hay anuncios activos. Crea uno para que los usuarios lo vean en cada interacción.";
    }
    const list = items
        .map((a, i) => `*${i + 1}.* ${a.texto}\n   📅 ${a.fecha}`)
        .join("\n\n");
    return `📢 *Anuncios Globales* — ${items.length} activo(s)\n\n${list}\n\n_Los usuarios verán estos anuncios como banner en cada interacción._`;
}
