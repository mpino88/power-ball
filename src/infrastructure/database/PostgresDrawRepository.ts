import { getDbPool } from "./PostgresConnection.js";
import type { DateDrawsMap } from "../../domain/models/Strategy.js";

/**
 * Century-aware sort expression for MM/DD/YY string dates stored as TEXT.
 *
 * Problem: plain `ORDER BY date DESC` uses lexicographic order, where
 *   "12/31/99" (Dec 31, 1999) > "03/24/26" (Mar 24, 2026)
 * causing historical 1988-1999 dates to be fetched BEFORE 2024-2026 dates
 * and LIMIT 4000 to silently return wrong (old) data.
 *
 * Fix: build a YYYYMMDD integer in SQL using the same century rule as mmddyyToDate():
 *   year <= 49  → 2000s
 *   year >= 50  → 1900s
 *
 * date format: MM/DD/YY  → SUBSTRING(date,1,2)=MM  SUBSTRING(date,4,2)=DD  SUBSTRING(date,7,2)=YY
 */
const CENTURY_AWARE_DATE_SORT = `
  (CASE WHEN SUBSTRING(date, 7, 2)::INTEGER <= 49 THEN 2000 ELSE 1900 END
   + SUBSTRING(date, 7, 2)::INTEGER) * 10000
  + SUBSTRING(date, 1, 2)::INTEGER * 100
  + SUBSTRING(date, 4, 2)::INTEGER
`;

// Extrae el DateDrawsMap de PostgreSQL (limite de últimos ~4000 draws para no explotar memoria local)
export async function loadDrawsFromDB(game: "p3" | "p4"): Promise<DateDrawsMap> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT date, period, numbers FROM draws WHERE game = $1 ORDER BY ${CENTURY_AWARE_DATE_SORT} DESC LIMIT 4000`,
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

/**
 * Inserta o actualiza un único sorteo en PostgreSQL.
 * Si ya existe un registro para (date, game, period) actualiza los números.
 * Esto evita duplicados al usar el menú "Actualizar Sorteo Hoy".
 */
export async function upsertDrawInDB(
  date: string,
  game: "p3" | "p4",
  period: "m" | "e",
  numbers: number[]
): Promise<void> {
  const pool = getDbPool();
  await pool.query(
    `INSERT INTO draws (date, game, period, numbers)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (date, game, period) DO UPDATE SET numbers = EXCLUDED.numbers`,
    [date, game, period, numbers.join(",")]
  );
}
