import cron from "node-cron";

/** Callback invoked when CronRunner detects new draw results not yet in hoy-results.json */
export type OnNewDrawFn = (period: "m" | "e") => Promise<void>;

/**
 * Initializes scheduled cron jobs.
 *
 * @param onNewDraw  Optional callback — called when a new draw is detected during
 *                   backup window polls. Powers the auto-broadcast path without
 *                   needing the lottery-monitor webhook (acts as safety net).
 */
export function initCronJobs(onNewDraw?: OnNewDrawFn): void {
  const tz = "America/New_York";

  // ── Backup window polls (always active — safety net for lottery-monitor) ──
  // These fire AFTER expected YouTube video publication and check if hoy-results.json
  // is missing today's data. If so, they trigger onNewDraw to force a PDF scrape + broadcast.
  // This covers: webhook downtime, lottery-monitor restart, network blips.
  if (!onNewDraw) {
    console.log("[CRON] onNewDraw callback not provided — backup auto-broadcast disabled.");
    return;
  }

  // Capture in a non-optional local so TypeScript can confirm it's always defined inside closures
  const notify: OnNewDrawFn = onNewDraw;

  async function checkAndNotify(period: "m" | "e", label: string): Promise<void> {
    console.log(`[CRON-BACKUP] 🔍 Checking ${label} — verifying hoy-results...`);
    try {
      // Dynamic import to avoid circular deps at module load time
      const { getHoyResult, getTodayEST } = await import("../../hoy-results.js");
      const today = getTodayEST();
      const current = getHoyResult();

      const p3Key = period === "m" ? "p3_m" : "p3_e";
      const p3DateKey = period === "m" ? "p3_m_date" : "p3_e_date";
      const savedValue = current[p3Key];
      const savedDate = current[p3DateKey];

      if (savedValue && savedDate === today) {
        console.log(`[CRON-BACKUP] ✅ ${label} already present (${savedValue}). Nothing to do.`);
        return;
      }

      console.log(`[CRON-BACKUP] ⚡ ${label} not yet in hoy-results (date=${savedDate}, today=${today}). Triggering auto-draw...`);
      await notify(period);
    } catch (e) {
      console.error(`[CRON-BACKUP] ❌ ${label} check failed:`, e instanceof Error ? e.message : e);
    }
  }

  // Midday backup polls: 13:35 and 13:50 ET (draw at 13:30)
  cron.schedule("35 13 * * *", () => checkAndNotify("m", "Midday backup-1 (13:35)"), { timezone: tz });
  cron.schedule("50 13 * * *", () => checkAndNotify("m", "Midday backup-2 (13:50)"), { timezone: tz });

  // Evening backup polls: 21:55 and 22:10 ET (draw at 21:45)
  cron.schedule("55 21 * * *", () => checkAndNotify("e", "Evening backup-1 (21:55)"), { timezone: tz });
  cron.schedule("10 22 * * *", () => checkAndNotify("e", "Evening backup-2 (22:10)"), { timezone: tz });

  console.log("[CRON] Backup window polls registrados: 13:35, 13:50 (Midday) | 21:55, 22:10 ET (Evening)");
}
