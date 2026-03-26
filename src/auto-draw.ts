/**
 * AUTO-DRAW MODULE — Bliss Systems LLC
 *
 * Handles automated lottery draw updates triggered by the lottery-monitor webhook.
 * Replaces the daily manual "actualizar sorteo" admin flow.
 *
 * Flow:
 *  lottery-monitor detects YouTube video
 *    → POST /api/auto-draw
 *      → force-refresh FL Lottery PDF
 *        → extract today's numbers
 *          → saveHoyResult()
 *            → broadcast to all users
 */

import type { Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { saveHoyResult, getHoyResult, getTodayEST, type HoyResult } from "./hoy-results.js";
import { getAllowedUsers } from "./user-config.js";
import { findWinningStrategies } from "./neuro-hit-engine.js";
import { escapeMd } from "./security/callbacks.js";
import type { DateDrawsMap } from "./domain/models/Strategy.js";

export interface AutoDrawDeps {
  getP3Map: () => Promise<DateDrawsMap>;
  getP4Map: () => Promise<DateDrawsMap>;
  botApi: Api;
  forceInvalidateCache: () => void;
  getExtraMenuLabel: (id: string) => string | undefined;
  buildMainKeyboard: (uid: number) => InlineKeyboardMarkup;
  getHotThresholdDays: () => number;
}

export interface AutoDrawResult {
  found: boolean;
  period?: string;
  p3?: string;
  p4?: string;
  usersNotified?: number;
  message?: string;
}

export interface AutoDrawRequest {
  period: "m" | "e";
  drawType?: string;
  videoId?: string;
  videoUrl?: string;
  videoTitle?: string;
  detectedAt?: string;
  secret?: string;
  extractedNumbers?: {
    p3: string | null;
    p4: string | null;
    confidence: "high" | "medium" | "low";
    source: string;
  };
}

/**
 * Factory — returns the auto-draw handler bound to live bot dependencies.
 * Call once during bot startup, reuse the returned function.
 */
export function createAutoDrawHandler(deps: AutoDrawDeps) {
  return async function handleAutoDraw(req: AutoDrawRequest): Promise<AutoDrawResult> {
    const { period, extractedNumbers } = req;
    const periodLabel = period === "m" ? "☀️ Mediodía" : "🌙 Noche";
    const today = getTodayEST();

    console.log(`[AUTO-DRAW] 🎯 Triggered — ${periodLabel} (${today}) | source: ${req.drawType ?? "unknown"} | video: ${req.videoId ?? "n/a"}`);

    if (extractedNumbers) {
      console.log(`[AI-EXTRACT] 🧠 Numbers received via AI: P3=${extractedNumbers.p3 ?? "?"} P4=${extractedNumbers.p4 ?? "?"} [${extractedNumbers.confidence.toUpperCase()}]`);
    }

    let p3Val = "";
    let p4Val = "";
    let skipPdf = false;

    // Use AI extracted numbers if confidence is HIGH
    if (extractedNumbers && extractedNumbers.confidence === "high" && (extractedNumbers.p3 || extractedNumbers.p4)) {
      console.log(`[AUTO-DRAW] 🚀 High confidence AI extraction — skipping PDF scrape`);
      p3Val = extractedNumbers.p3 || "";
      p4Val = extractedNumbers.p4 || "";
      skipPdf = true;
    }

    if (!skipPdf) {
      // Force cache bust so we always get the freshest PDF data
      deps.forceInvalidateCache();

      let p3Map: DateDrawsMap;
      let p4Map: DateDrawsMap;

      try {
        [p3Map, p4Map] = await Promise.all([deps.getP3Map(), deps.getP4Map()]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[AUTO-DRAW] ❌ PDF fetch failed: ${msg}`);
        // If we have medium confidence numbers, we could fallback to them here instead of failing
        if (extractedNumbers && extractedNumbers.confidence === "medium" && (extractedNumbers.p3 || extractedNumbers.p4)) {
          console.warn(`[AUTO-DRAW] ⚠️ PDF failed, falling back to MEDIUM confidence AI numbers`);
          p3Val = extractedNumbers.p3 || "";
          p4Val = extractedNumbers.p4 || "";
        } else {
          return { found: false, message: `pdf_fetch_failed: ${msg}` };
        }
      }

      if (!p3Val && !p4Val) {
        const p3nums = p3Map![today]?.[period]; // number[] | undefined
        const p4nums = p4Map![today]?.[period]; // number[] | undefined

        if (!p3nums && !p4nums) {
          console.log(`[AUTO-DRAW] ⏳ PDF has no data yet for ${today} ${periodLabel}`);
          return { found: false, message: `no_data_yet:${today}:${period}` };
        }

        p3Val = p3nums ? p3nums.join("") : "";
        p4Val = p4nums ? p4nums.join("") : "";
      }
    }

    // Guard against duplicate broadcasts (idempotency)
    const current = getHoyResult();
    const savedP3 = period === "m" ? current.p3_m : current.p3_e;
    const savedP4 = period === "m" ? current.p4_m : current.p4_e;

    if (savedP3 === p3Val && savedP4 === p4Val && savedP3 !== undefined) {
      console.log(`[AUTO-DRAW] ✅ Already saved (P3=${p3Val}, P4=${p4Val}) — skipping duplicate broadcast`);
      return { found: true, p3: p3Val, p4: p4Val, usersNotified: 0, message: "already_saved" };
    }

    // Persist results
    const update: Partial<HoyResult> = {};
    if (period === "m") {
      update.p3_m = p3Val;
      update.p4_m = p4Val;
    } else {
      update.p3_e = p3Val;
      update.p4_e = p4Val;
    }
    saveHoyResult(update);
    console.log(`[AUTO-DRAW] 💾 Saved: ${periodLabel} P3=${p3Val || "-"} P4=${p4Val || "-"}`);

    // Compute winning strategy hits for the new result
    let hitsP3: { id: string; label: string }[] = [];
    let hitsP4: { id: string; label: string }[] = [];
    try {
      const winningHits = await findWinningStrategies(
        { getP3Map: deps.getP3Map, getP4Map: deps.getP4Map },
        deps.getHotThresholdDays()
      );
      hitsP3 = winningHits[period === "m" ? "p3_m" : "p3_e"] ?? [];
      hitsP4 = winningHits[period === "m" ? "p4_m" : "p4_e"] ?? [];
    } catch (e) {
      console.warn(`[AUTO-DRAW] ⚠️ findWinningStrategies failed (non-fatal): ${e instanceof Error ? e.message : e}`);
    }

    // Build broadcast message (mirrors manual flow in messageHandler.ts)
    const formatHits = (hits: { id: string; label: string }[]) => {
      if (hits.length === 0) {
        return `\n\n⚡ *Algoritmos Validados:* _Recalibrando análisis predictivo..._`;
      }
      const uniqueLabels = [
        ...new Set(hits.map((h) => escapeMd(deps.getExtraMenuLabel(h.label) || h.label))),
      ];
      return `\n\n⚡ *Algoritmos Validados:*\n` + uniqueLabels.map((l) => ` ➥ ${l}`).join("\n");
    };

    const formatVal = (v: string) => v.split("").join("-");
    let notification = `🤖 *Auto-Sorteo: ${periodLabel}*\n\n`;
    if (p3Val) notification += `🎯 Pick 3 (Fijo): *${formatVal(p3Val)}*${formatHits(hitsP3)}\n\n`;
    if (p4Val) notification += `🎲 Pick 4 (Corrido): *${formatVal(p4Val)}*${formatHits(hitsP4)}\n`;
    notification += "\nConsulta todos los detalles en ☀️🌙 Últimos Sorteos 🏆";

    // Broadcast to all allowed users
    const allowed = getAllowedUsers();
    let sentCount = 0;

    if (p3Val || p4Val) {
      for (const uid of allowed) {
        try {
          await deps.botApi.sendMessage(uid, notification, {
            parse_mode: "Markdown",
            reply_markup: deps.buildMainKeyboard(uid),
          });
          sentCount++;
        } catch {
          // Ignore per-user errors (blocked bot, deleted account, etc.)
        }
      }
    }

    console.log(`[AUTO-DRAW] 📣 Broadcast complete — ${sentCount}/${allowed.length} users notified`);
    return { found: true, p3: p3Val, p4: p4Val, usersNotified: sentCount };
  };
}
