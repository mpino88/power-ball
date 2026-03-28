/**
 * PostgresPendingInteractionRepository
 *
 * Reemplaza los Maps en-memoria `pendingPlanRequest` y `pendingRenewal`
 * de middleware.ts por persistencia en PostgreSQL.
 *
 * Problema que resuelve (GAP-03):
 *   Los Maps viven en RAM del proceso Node. Un reinicio de Render (deploy,
 *   health check failure, OOM) borra el estado de cualquier usuario que
 *   esté en mitad del flujo de solicitud de plan — el bot olvida que está
 *   esperando el teléfono del usuario.
 *
 * Solución:
 *   Cada vez que se hace `pendingMap.set()` → UPSERT en esta tabla.
 *   Cada vez que se hace `pendingMap.get()` → SELECT de esta tabla.
 *   TTL: 30 minutos. Al arrancar el bot se limpian rows expirados.
 */

import { getDbPool } from "./PostgresConnection.js";

export interface PendingInteraction {
  planId: string;
  planName: string;
  temporality: string;
}

const TTL_MINUTES = 30;

// ─── Escritura ────────────────────────────────────────────────────────────────

/**
 * Persiste o actualiza la interacción pendiente del usuario.
 * @param type 'plan_request' (usuario nuevo) | 'plan_renewal' (usuario con plan expirado)
 */
export async function setPendingInteraction(
  userId: number,
  type: "plan_request" | "plan_renewal",
  data: PendingInteraction
): Promise<void> {
  const pool = getDbPool();
  const expiresAt = new Date(Date.now() + TTL_MINUTES * 60 * 1000);
  try {
    await pool.query(
      `INSERT INTO pending_interactions (user_id, type, plan_id, plan_name, temporality, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         type        = EXCLUDED.type,
         plan_id     = EXCLUDED.plan_id,
         plan_name   = EXCLUDED.plan_name,
         temporality = EXCLUDED.temporality,
         expires_at  = EXCLUDED.expires_at,
         created_at  = CURRENT_TIMESTAMP`,
      [userId, type, data.planId, data.planName, data.temporality, expiresAt]
    );
    console.log(`[PendingInteraction] SET userId=${userId} type=${type} plan=${data.planId} temp=${data.temporality}`);
  } catch (e) {
    console.error("[PendingInteraction] Error en SET:", e);
    throw e;
  }
}

// ─── Lectura ──────────────────────────────────────────────────────────────────

/**
 * Obtiene la interacción pendiente del usuario si existe y no ha expirado.
 * Retorna null si no hay pendiente o si expiró (TTL 30min).
 */
export async function getPendingInteraction(
  userId: number,
  type: "plan_request" | "plan_renewal"
): Promise<PendingInteraction | null> {
  const pool = getDbPool();
  try {
    const { rows } = await pool.query(
      `SELECT plan_id, plan_name, temporality, expires_at
       FROM pending_interactions
       WHERE user_id = $1 AND type = $2 AND expires_at > NOW()`,
      [userId, type]
    );
    if (rows.length === 0) return null;
    const r = rows[0]!;
    return { planId: r.plan_id, planName: r.plan_name, temporality: r.temporality };
  } catch (e) {
    console.error("[PendingInteraction] Error en GET:", e);
    return null;
  }
}

// ─── Eliminación ──────────────────────────────────────────────────────────────

/**
 * Elimina la interacción pendiente del usuario (tras procesar el contacto o cancelar).
 */
export async function deletePendingInteraction(
  userId: number,
  type: "plan_request" | "plan_renewal"
): Promise<void> {
  const pool = getDbPool();
  try {
    await pool.query(
      `DELETE FROM pending_interactions WHERE user_id = $1 AND type = $2`,
      [userId, type]
    );
    console.log(`[PendingInteraction] DELETE userId=${userId} type=${type}`);
  } catch (e) {
    console.error("[PendingInteraction] Error en DELETE:", e);
  }
}

// ─── Limpieza TTL (ejecutar al arranque del bot) ──────────────────────────────

/**
 * Elimina todas las interacciones expiradas.
 * Llamar una vez en el arranque del bot para mantener la tabla limpia.
 */
export async function cleanExpiredPendingInteractions(): Promise<void> {
  const pool = getDbPool();
  try {
    const { rowCount } = await pool.query(
      `DELETE FROM pending_interactions WHERE expires_at < NOW()`
    );
    if ((rowCount ?? 0) > 0) {
      console.log(`[PendingInteraction] Limpiados ${rowCount} registro(s) expirado(s)`);
    }
  } catch (e) {
    console.error("[PendingInteraction] Error en cleanup TTL:", e);
  }
}
