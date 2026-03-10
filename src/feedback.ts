/**
 * Módulo de Feedback: helpers de presentación y paginación.
 * La persistencia (Sheet) se hace desde user-config.ts.
 */

import type { FeedbackRow } from "./user-config.js";

export { loadFeedbackFromSheet, appendFeedbackToSheet, getFeedbackForUser } from "./user-config.js";
export type { FeedbackRow } from "./user-config.js";

export const FEEDBACK_PAGE_SIZE = 5;
export const FEEDBACK_MAX_TEXT = 500;

/** Zona horaria Florida para las fechas de feedback. */
const FLORIDA_TZ = "America/New_York";

/** Formatea la fecha actual en "DD/MM/YYYY HH:MM" con hora Florida. */
export function nowFeedbackDate(): string {
    const now = new Date();
    return now.toLocaleString("es-ES", {
        timeZone: FLORIDA_TZ,
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).replace(",", "");
}

// ─── Vista usuario: "Mis feedbacks" ──────────────────────────────────────────

/** Construye el texto paginado de los feedbacks propios del usuario. */
export function buildMyFeedbacksMessage(
    items: FeedbackRow[],
    page: number
): { text: string; totalPages: number } {
    const totalPages = Math.max(1, Math.ceil(items.length / FEEDBACK_PAGE_SIZE));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const slice = items.slice(safePage * FEEDBACK_PAGE_SIZE, (safePage + 1) * FEEDBACK_PAGE_SIZE);

    if (items.length === 0) {
        return {
            text: "📋 *Mis feedbacks*\n\nAún no has enviado ningún feedback.",
            totalPages: 1,
        };
    }

    const header = `📋 *Mis feedbacks* — Página ${safePage + 1}/${totalPages}\n\n`;
    const body = slice
        .map((row, i) => {
            const n = safePage * FEEDBACK_PAGE_SIZE + i + 1;
            return `*${n}.* 📅 ${row.fecha}\n${row.texto}`;
        })
        .join("\n\n─────────────────\n\n");

    return { text: header + body, totalPages };
}

// ─── Vista admin: lista de usuarios ──────────────────────────────────────────

export interface FeedbackUserSummary {
    userId: number;
    nombre: string;
    telefono: string;
    count: number;
    lastDate: string;
}

/** Agrupa feedbacks por usuario y devuelve resumen ordenado por fecha del último (más reciente primero). */
export function groupFeedbackByUser(items: FeedbackRow[]): FeedbackUserSummary[] {
    const map = new Map<number, FeedbackUserSummary>();
    for (const row of items) {
        const existing = map.get(row.userId);
        if (!existing) {
            map.set(row.userId, {
                userId: row.userId,
                nombre: row.nombre || `User ${row.userId}`,
                telefono: row.telefono,
                count: 1,
                lastDate: row.fecha,
            });
        } else {
            existing.count++;
            // Conservar la fecha más reciente (comparación lexicográfica sobre DD/MM/YYYY HH:MM)
            if (row.fecha > existing.lastDate) existing.lastDate = row.fecha;
        }
    }
    return Array.from(map.values()).sort((a, b) => (b.lastDate > a.lastDate ? 1 : -1));
}

/** Construye el texto paginado de la lista de usuarios con feedbacks para el admin. */
export function buildAdminFeedbackListMessage(
    users: FeedbackUserSummary[],
    page: number
): { text: string; totalPages: number } {
    const totalPages = Math.max(1, Math.ceil(users.length / FEEDBACK_PAGE_SIZE));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const slice = users.slice(safePage * FEEDBACK_PAGE_SIZE, (safePage + 1) * FEEDBACK_PAGE_SIZE);

    if (users.length === 0) {
        return {
            text: "📣 *Feedback — Panel Admin*\n\nAún no hay feedbacks de usuarios.",
            totalPages: 1,
        };
    }

    const header = `📣 *Feedback — Panel Admin*\nPágina ${safePage + 1}/${totalPages} · ${users.length} usuario(s)\n\n`;
    const body = slice
        .map((u, i) => {
            const n = safePage * FEEDBACK_PAGE_SIZE + i + 1;
            const nombre = u.nombre || `User ${u.userId}`;
            return `*${n}.* 👤 ${nombre}\n📨 ${u.count} mensaje(s) · 🕐 ${u.lastDate}`;
        })
        .join("\n\n");

    return { text: header + body + "\n\n_Pulsa un usuario para ver sus mensajes:_", totalPages };
}

/** Construye el texto paginado de los mensajes de un usuario específico (vista admin). */
export function buildAdminUserFeedbackMessage(
    items: FeedbackRow[],
    targetUserId: number,
    page: number
): { text: string; totalPages: number; nombre: string } {
    const nombre = items[0]?.nombre || `User ${targetUserId}`;
    const totalPages = Math.max(1, Math.ceil(items.length / FEEDBACK_PAGE_SIZE));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const slice = items.slice(safePage * FEEDBACK_PAGE_SIZE, (safePage + 1) * FEEDBACK_PAGE_SIZE);

    if (items.length === 0) {
        return {
            text: `👤 *${nombre}* — Sin mensajes`,
            totalPages: 1,
            nombre,
        };
    }

    const header = `👤 *${nombre}* · ID: \`${targetUserId}\`\nPágina ${safePage + 1}/${totalPages}\n\n`;
    const body = slice
        .map((row, i) => {
            const n = safePage * FEEDBACK_PAGE_SIZE + i + 1;
            return `*${n}.* 📅 ${row.fecha}\n${row.texto}`;
        })
        .join("\n\n─────────────────\n\n");

    return { text: header + body, totalPages, nombre };
}
