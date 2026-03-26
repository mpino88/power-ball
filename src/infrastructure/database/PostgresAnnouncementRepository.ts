import { getDbPool } from "./PostgresConnection.js";
import type { AnnouncementRow } from "../../user-config.js";

// announcements DB schema: id SERIAL, text TEXT, timestamp BIGINT
// AnnouncementRow: id (string = timestamp ms), texto, fecha (DD/MM/YYYY HH:MM)

function rowToAnnouncement(r: { id: number; text: string; timestamp: string }): AnnouncementRow {
  const ts = Number(r.timestamp);
  const fecha = ts ? new Date(ts).toLocaleString("es-ES", {
    timeZone: "America/New_York",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).replace(",", "") : "";
  return { id: String(r.timestamp), texto: r.text, fecha };
}

export async function loadAnnouncementsFromPG(): Promise<AnnouncementRow[]> {
  const pool = getDbPool();
  try {
    const { rows } = await pool.query("SELECT id, text, timestamp FROM announcements ORDER BY timestamp ASC");
    return rows.map(rowToAnnouncement);
  } catch (e) {
    console.error("[PostgresAnnouncementRepository] Error loading:", e);
    return [];
  }
}

export async function saveAnnouncementsToPG(items: AnnouncementRow[]): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM announcements");
    for (const item of items) {
      await client.query(
        "INSERT INTO announcements (text, timestamp) VALUES ($1, $2)",
        [item.texto, BigInt(item.id)]
      );
    }
    await client.query("COMMIT");
    console.log("[PostgresAnnouncementRepository] Saved", items.length, "announcements.");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[PostgresAnnouncementRepository] Error saving:", e);
    throw e;
  } finally {
    client.release();
  }
}

export async function addAnnouncementToPG(texto: string, fecha: string): Promise<AnnouncementRow[]> {
  const ts = Date.now();
  const pool = getDbPool();
  await pool.query("INSERT INTO announcements (text, timestamp) VALUES ($1, $2)", [texto, BigInt(ts)]);
  console.log("[PostgresAnnouncementRepository] Added announcement ts=", ts);
  return loadAnnouncementsFromPG();
}

export async function editAnnouncementInPG(id: string, newTexto: string): Promise<AnnouncementRow[] | null> {
  const pool = getDbPool();
  const { rowCount } = await pool.query(
    "UPDATE announcements SET text=$1 WHERE timestamp=$2",
    [newTexto, BigInt(id)]
  );
  if (!rowCount) return null;
  return loadAnnouncementsFromPG();
}

export async function deleteAnnouncementFromPG(id: string): Promise<AnnouncementRow[] | null> {
  const pool = getDbPool();
  const { rowCount } = await pool.query("DELETE FROM announcements WHERE timestamp=$1", [BigInt(id)]);
  if (!rowCount) return null;
  return loadAnnouncementsFromPG();
}
