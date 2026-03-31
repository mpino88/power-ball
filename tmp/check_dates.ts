import { getDbPool } from "../src/infrastructure/database/PostgresConnection.js";

async function checkDates() {
  const pool = getDbPool();
  const sql = `
    SELECT game, COUNT(*), MIN(date) as min_raw, MAX(date) as max_raw
    FROM draws
    GROUP BY game;
  `;
  const { rows } = await pool.query(sql);
  console.log("Counts and Raw Min/Max:", rows);

  const sqlFull = `
    SELECT game, date, (CASE WHEN SUBSTRING(date, 7, 2)::INTEGER <= 49 THEN 2000 ELSE 1900 END + SUBSTRING(date, 7, 2)::INTEGER) * 10000 
    + SUBSTRING(date, 1, 2)::INTEGER * 100 
    + SUBSTRING(date, 4, 2)::INTEGER as sort_key
    FROM draws
    ORDER BY sort_key ASC
    LIMIT 1;
  `;
  const { rows: oldest } = await pool.query(sqlFull);
  console.log("Oldest date by sortKey:", oldest);

  const sqlFullMax = `
    SELECT game, date, (CASE WHEN SUBSTRING(date, 7, 2)::INTEGER <= 49 THEN 2000 ELSE 1900 END + SUBSTRING(date, 7, 2)::INTEGER) * 10000 
    + SUBSTRING(date, 1, 2)::INTEGER * 100 
    + SUBSTRING(date, 4, 2)::INTEGER as sort_key
    FROM draws
    ORDER BY sort_key DESC
    LIMIT 1;
  `;
  const { rows: newest } = await pool.query(sqlFullMax);
  console.log("Newest date by sortKey:", newest);

  process.exit(0);
}

checkDates().catch(err => {
  console.error(err);
  process.exit(1);
});
