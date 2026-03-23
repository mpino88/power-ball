import { getDbPool } from "./PostgresConnection.js";
import type { DateDrawsMap } from "../../domain/models/Strategy.js";

// Extrae el DateDrawsMap de PostgreSQL (limite de últimos ~4000 draws para no explotar memoria local)
export async function loadDrawsFromDB(game: "p3" | "p4"): Promise<DateDrawsMap> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    "SELECT date, period, numbers FROM draws WHERE game = $1 ORDER BY date DESC LIMIT 4000",
    [game]
  );

  const map: DateDrawsMap = {};
  for (const row of rows) {
    const d = row.date;
    const p = row.period as "m" | "e";
    const nums: number[] = row.numbers.split(",").map(Number);
    if (!map[d]) {
      map[d] = {};
    }
    map[d][p] = nums;
  }
  return map;
}

// Guarda un DateDrawsMap en PostgreSQL. Usa ON CONFLICT DO NOTHING para idempotencia total.
export async function saveDrawsToDB(game: "p3" | "p4", map: DateDrawsMap): Promise<void> {
  const pool = getDbPool();
  const values: any[] = [];
  const queries: string[] = [];
  let paramIndex = 1;

  for (const [date, periods] of Object.entries(map)) {
    if (periods.m) {
      queries.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      values.push(date, game, "m", periods.m.join(","));
    }
    if (periods.e) {
      queries.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`);
      values.push(date, game, "e", periods.e.join(","));
    }
  }

  if (queries.length === 0) return;

  const BATCH_SIZE = 1000;
  for (let idx = 0; idx < queries.length; idx += BATCH_SIZE) {
    const chunkQ = queries.slice(idx, idx + BATCH_SIZE);
    const chunkV = values.slice(idx * 4, (idx + BATCH_SIZE) * 4);
    
    let reI = 1;
    const reChunkQ = chunkQ.map(() => `($${reI++}, $${reI++}, $${reI++}, $${reI++})`);

    const sql = `
      INSERT INTO draws (date, game, period, numbers) 
      VALUES ${reChunkQ.join(", ")}
      ON CONFLICT (date, game, period) DO NOTHING
    `;
    await pool.query(sql, chunkV);
  }
}
