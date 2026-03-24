import cron from "node-cron";
import { runDailyScrape } from "./DailyScraper.js";

export function initCronJobs() {
  if (!process.env.DATABASE_URL) {
    console.log("[CRON] Modo Legacy (Sheet): Scheduler omitido.");
    return;
  }

  // Ejecuciones programadas para coincidir justo después de que Florida Lottery publique
  // Sorteos son a 1:30 PM (Midday) y 9:45 PM (Evening). PDF suele actualizar a las 14:05 / 20:20 (Evening Fireball).
  const tz = "America/New_York";

  cron.schedule("15 14 * * *", async () => {
    console.log("[CRON] Disparo programado: 14:15 ET (Midday)");
    await runDailyScrape();
  }, { timezone: tz });

  cron.schedule("30 20 * * *", async () => {
    console.log("[CRON] Disparo programado: 20:30 ET (Evening)");
    await runDailyScrape();
  }, { timezone: tz });

  // Disparo al inicio (asincrono no bloqueante)
  setTimeout(() => {
    console.log("[CRON] Disparo de arranque en frío...");
    runDailyScrape().catch(e => console.error(e));
  }, 10000);
}
