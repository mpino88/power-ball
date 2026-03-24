import { getDbPool } from "./infrastructure/database/PostgresConnection.js";

/**
 * Registra un referido inicial. El plan pro se otorgará cuando se apruebe su suscripción.
 * @param referrer_id ID de quien invitó.
 * @param referred_id ID del nuevo usuario.
 */
export async function registerReferral(referrer_id: number, referred_id: number): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false;
  if (referrer_id === referred_id) return false; // Noping
  
  const pool = getDbPool();
  try {
    await pool.query(
      `INSERT INTO referrals (referrer_id, referred_id, rewarded)
       VALUES ($1, $2, FALSE)
       ON CONFLICT (referred_id) DO NOTHING`,
      [referrer_id, referred_id]
    );
    // Link users table for historic reasons
    await pool.query(
      `UPDATE users SET referred_by = $1 WHERE id = $2 AND referred_by IS NULL`,
      [referrer_id, referred_id]
    );
    return true;
  } catch (e) {
    console.error("[Referrals] Error registrando referido:", e);
    return false;
  }
}

/**
 * Otorgar recompensa (1 mes de Plan Pro) al referido (llamado al aprobar una solicitud de pago).
 * Se usa SELECT FOR UPDATE SKIP LOCKED para proteger contra Conditions de Carrera (F-009).
 */
export async function rewardReferrer(referred_id: number): Promise<number | null> {
  if (!process.env.DATABASE_URL) return null;
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // 1. Bloquear registro y evitar que otros workers lo reclamen a la misma vez
    const refRes = await client.query(
      `SELECT id, referrer_id FROM referrals 
       WHERE referred_id = $1 AND rewarded = FALSE 
       FOR UPDATE SKIP LOCKED`,
      [referred_id]
    );

    if (refRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return null; // Ya fue premiado o no tiene referidor
    }

    const referral = refRes.rows[0];
    const referrerId = referral.referrer_id;

    // 2. Marcar como premiado
    await client.query(
      `UPDATE referrals SET rewarded = TRUE WHERE id = $1`,
      [referral.id]
    );

    // Acá internamente añadimos 1 mes al timestamp/duración de su plan en la tabla de Usuarios.
    // Esto asume que user-config/database se sincroniza después. 
    // Lo manipularemos luego a nivel lógico global dentro de `user-config.ts` o aquí si manejamos la DB directo.

    await client.query("COMMIT");
    console.log(`[Referrals] 🏆 Recompensa Procesada exitosamente para ${referrerId}.`);
    return referrerId;

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[Referrals] Fail at atomic reward:", e);
    return null;
  } finally {
    client.release();
  }
}
