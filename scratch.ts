import { getDbPool } from "./src/infrastructure/database/PostgresConnection.js";
const pool = getDbPool();
async function run() {
  await pool.query("DELETE FROM plans WHERE id = 'basico'");
  await pool.query("UPDATE plans SET description = 'Acceso total a estadísticas avanzadas, análisis predictivo profundo, resultados diarios y herramientas de alto nivel para maximizar tu rendimiento y gestionar tus recursos al más alto nivel.' WHERE id = 'pro'");
  console.log("Done");
  process.exit(0);
}
run();
