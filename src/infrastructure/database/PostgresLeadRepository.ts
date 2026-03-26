import { getDbPool } from "./PostgresConnection.js";
import type { LeadRow } from "../../user-config.js";

// leads schema: id SERIAL, user_id BIGINT UNIQUE, nombre, telefono, plan, temporality, fecha, status, created_at

export async function saveLeadToPG(
  userId: number,
  name: string,
  phone: string,
  plan: string,
  temporality: string,
  status = "trial_active"
): Promise<void> {
  const pool = getDbPool();
  const fecha = new Date().toLocaleString("es-ES", {
    timeZone: "America/New_York",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).replace(",", "");
  try {
    await pool.query(
      `INSERT INTO leads (user_id, nombre, telefono, plan, temporality, fecha, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (user_id) DO UPDATE SET
         nombre=EXCLUDED.nombre, telefono=EXCLUDED.telefono, plan=EXCLUDED.plan,
         temporality=EXCLUDED.temporality, fecha=EXCLUDED.fecha, status=EXCLUDED.status`,
      [userId, name, phone, plan, temporality, fecha, status]
    );
    console.log("[PostgresLeadRepository] UPSERT lead userId=", userId);
  } catch (e) {
    console.error("[PostgresLeadRepository] Error saving lead:", e);
    throw e;
  }
}

export async function loadLeadsFromPG(): Promise<LeadRow[]> {
  const pool = getDbPool();
  try {
    const { rows } = await pool.query(
      "SELECT user_id, nombre, telefono, plan, temporality, fecha, status FROM leads ORDER BY created_at ASC"
    );
    return rows.map((r) => ({
      userId: String(r.user_id),
      nombre: r.nombre ?? "",
      telefono: r.telefono ?? "",
      plan: r.plan ?? "",
      temporality: r.temporality ?? "",
      fecha: r.fecha ?? "",
      status: r.status ?? "",
    }));
  } catch (e) {
    console.error("[PostgresLeadRepository] Error loading leads:", e);
    return [];
  }
}
