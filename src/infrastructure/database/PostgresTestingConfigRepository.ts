import { getDbPool } from "./PostgresConnection.js";

// testing_config schema: key VARCHAR PK, value VARCHAR
// Keys: "cutoff_{userId}" → value: "MM/DD/YY" or empty

export async function saveTestingCutoffDatePG(date: string | null, userId: number): Promise<void> {
  const pool = getDbPool();
  const key = `cutoff_${userId}`;
  try {
    if (date === null) {
      await pool.query("DELETE FROM testing_config WHERE key=$1", [key]);
      console.log("[PostgresTestingConfigRepository] Deleted cutoff for userId=", userId);
    } else {
      await pool.query(
        "INSERT INTO testing_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
        [key, date]
      );
      console.log("[PostgresTestingConfigRepository] Saved cutoff", date, "for userId=", userId);
    }
  } catch (e) {
    console.error("[PostgresTestingConfigRepository] Error saving cutoff:", e);
    throw e;
  }
}

export async function loadTestingCutoffDatePG(userId: number): Promise<string | null> {
  const pool = getDbPool();
  const key = `cutoff_${userId}`;
  try {
    const { rows } = await pool.query("SELECT value FROM testing_config WHERE key=$1", [key]);
    if (!rows.length) return null;
    const raw = String(rows[0].value ?? "").trim();
    if (!raw) return null;
    if (/^\d{1,2}\/\d{1,2}\/\d{2}$/.test(raw)) return raw;
    console.warn("[PostgresTestingConfigRepository] Invalid cutoff_date format:", raw);
    return null;
  } catch (e) {
    console.error("[PostgresTestingConfigRepository] Error loading cutoff:", e);
    return null;
  }
}

export async function saveGlobalTopNPG(n: number): Promise<void> {
  const pool = getDbPool();
  const key = "global_top_n";
  try {
    await pool.query(
      "INSERT INTO testing_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
      [key, String(n)]
    );
    console.log("[PostgresTestingConfigRepository] Saved global_top_n:", n);
  } catch (e) {
    console.error("[PostgresTestingConfigRepository] Error saving global_top_n:", e);
    throw e;
  }
}

export async function loadGlobalTopNPG(): Promise<number | null> {
  const pool = getDbPool();
  const key = "global_top_n";
  try {
    const { rows } = await pool.query("SELECT value FROM testing_config WHERE key=$1", [key]);
    if (!rows.length) return null;
    const val = parseInt(rows[0].value, 10);
    return Number.isNaN(val) ? null : val;
  } catch (e) {
    console.error("[PostgresTestingConfigRepository] Error loading global_top_n:", e);
    return null;
  }
}
