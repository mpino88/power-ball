import { getDbPool } from "./src/infrastructure/database/PostgresConnection.js";

async function checkCount() {
  const pool = getDbPool();
  const { rows } = await pool.query("SELECT game, COUNT(*) as total FROM draws GROUP BY game;");
  console.log(rows);
  process.exit(0);
}

checkCount().catch(err => {
  console.error(err);
  process.exit(1);
});
