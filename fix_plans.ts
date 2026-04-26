import { getDbPool } from "./src/infrastructure/database/PostgresConnection.js";

async function main() {
  const pool = getDbPool();
  try {
    const result = await pool.query(`
      UPDATE plans
      SET menu_ids = REPLACE(menu_ids, '-', '_')
      WHERE menu_ids LIKE '%-%'
    `);
    console.log(`Se actualizaron ${result.rowCount} planes.`);
  } catch (error) {
    console.error("Error al actualizar la base de datos:", error);
  } finally {
    await pool.end();
  }
}

main();
