import { getDbPool } from "./PostgresConnection.js";
import type { SugerenciaRow } from "../../user-config.js";

// suggestions schema: id SERIAL, user_id BIGINT, text TEXT, created_at TIMESTAMP,
//                     nombre VARCHAR, telefono VARCHAR, fecha VARCHAR

export async function loadSugerenciasFromPG(): Promise<SugerenciaRow[]> {
  const pool = getDbPool();
  try {
    const { rows } = await pool.query(
      "SELECT user_id, text, nombre, telefono, fecha FROM suggestions ORDER BY created_at ASC"
    );
    return rows.map((r) => ({
      userId: Number(r.user_id),
      nombre: r.nombre ?? "",
      telefono: r.telefono ?? "",
      texto: r.text,
      fecha: r.fecha ?? "",
    }));
  } catch (e) {
    console.error("[PostgresSugerenciaRepository] Error loading:", e);
    return [];
  }
}

export async function appendSugerenciaToPG(row: SugerenciaRow): Promise<void> {
  const pool = getDbPool();
  try {
    await pool.query(
      "INSERT INTO suggestions (user_id, text, nombre, telefono, fecha) VALUES ($1, $2, $3, $4, $5)",
      [row.userId, row.texto, row.nombre, row.telefono, row.fecha]
    );
    console.log("[PostgresSugerenciaRepository] Appended suggestion for userId=", row.userId);
  } catch (e) {
    console.error("[PostgresSugerenciaRepository] Error appending:", e);
    throw e;
  }
}

export async function getSugerenciaForUserPG(userId: number): Promise<SugerenciaRow[]> {
  const pool = getDbPool();
  try {
    const { rows } = await pool.query(
      "SELECT user_id, text, nombre, telefono, fecha FROM suggestions WHERE user_id=$1 ORDER BY created_at DESC",
      [userId]
    );
    return rows.map((r) => ({
      userId: Number(r.user_id),
      nombre: r.nombre ?? "",
      telefono: r.telefono ?? "",
      texto: r.text,
      fecha: r.fecha ?? "",
    }));
  } catch (e) {
    console.error("[PostgresSugerenciaRepository] Error querying for user:", e);
    return [];
  }
}
