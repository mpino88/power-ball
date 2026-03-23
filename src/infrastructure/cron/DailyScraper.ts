import { FloridaLotteryScraper } from "../api/FloridaLotteryScraper.js";
import { saveDrawsToDB } from "../database/PostgresDrawRepository.js";

export async function runDailyScrape(): Promise<void> {
  console.log("[CRON] Iniciando extracción forzada de sorteos P3/P4 -> PG...");
  const scraper = new FloridaLotteryScraper();
  
  try {
    await scraper.forceRefresh(); // Forza la recarga desde la web de FD
    const p3Map = await scraper.getP3Map();
    if (p3Map && Object.keys(p3Map).length > 0) {
      await saveDrawsToDB("p3", p3Map);
      console.log(`[CRON] P3 DB Sync Completo (${Object.keys(p3Map).length} fechas procesadas).`);
    }

    const p4Map = await scraper.getP4Map();
    if (p4Map && Object.keys(p4Map).length > 0) {
      await saveDrawsToDB("p4", p4Map);
      console.log(`[CRON] P4 DB Sync Completo (${Object.keys(p4Map).length} fechas procesadas).`);
    }
  } catch (e) {
    console.error(`[CRON] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  }
}
