/**
 * FloridaLotteryAuditor — Bliss Systems LLC
 *
 * Motor de auditoría forense que descarga los PDFs oficiales de Florida Lottery,
 * parsea todos los registros históricos y los compara registro a registro contra
 * la base de datos PostgreSQL para detectar discrepancias.
 *
 * Flujo:
 *  Admin → "🔍 Auditoría de Datos"
 *    → fetch P3.pdf + P4.pdf desde floridalottery.com
 *      → parsea todos los sorteos
 *        → compara vs draws table en PostgreSQL
 *          → genera AuditReport (faltantes, corruptos, extras)
 *            → opción de reparación automática con upsert quirúrgico
 *
 * @module FloridaLotteryAuditor
 */

import { getDbPool } from "../database/PostgresConnection.js";
import { upsertDrawInDB } from "../database/PostgresDrawRepository.js";
import type { DateDrawsMap } from "../../domain/models/Strategy.js";

// ── Florida Lottery PDF URLs ────────────────────────────────────────────────
const P3_PDF_URL = "https://files.floridalottery.com/exptkt/p3.pdf";
const P4_PDF_URL = "https://files.floridalottery.com/exptkt/p4.pdf";

// ── Regex para parsear registros del PDF ────────────────────────────────────
const P3_RECORD_REGEX =
  /(\d{2}\/\d{2}\/\d{2})\s*([EM])\s*(\d)[\s\-]*(\d)[\s\-]*(\d)(?:\s+FB\s*(\d))?/gi;
const P4_RECORD_REGEX =
  /(\d{2}\/\d{2}\/\d{2})\s*([EM])\s*(\d)[\s\-]*(\d)[\s\-]*(\d)[\s\-]*(\d)(?:\s+FB\s*(\d))?/gi;

// ── Configuración de resiliencia ────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 3_000;

// ── Tipos ───────────────────────────────────────────────────────────────────

export interface AuditDiscrepancy {
  date: string;
  period: "m" | "e";
  type: "missing" | "corrupted" | "extra_in_db";
  /** Números según el PDF oficial (vacío si type=extra_in_db) */
  pdfNumbers?: number[];
  /** Números según la DB (vacío si type=missing) */
  dbNumbers?: number[];
}

export interface AuditReport {
  game: "p3" | "p4";
  status: "CLEAN" | "DISCREPANCIES_FOUND" | "ERROR";
  totalPdf: number;
  totalDb: number;
  missing: AuditDiscrepancy[];
  corrupted: AuditDiscrepancy[];
  extraInDb: AuditDiscrepancy[];
  errorMessage?: string;
  durationMs: number;
}

export interface RepairResult {
  game: "p3" | "p4";
  inserted: number;
  updated: number;
  errors: string[];
  durationMs: number;
}

export interface FullAuditReport {
  p3: AuditReport;
  p4: AuditReport;
  totalDurationMs: number;
}

// ── Utilidades PDF ──────────────────────────────────────────────────────────

async function pdfToText(pdfBuffer: ArrayBuffer): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(pdfBuffer);
  const doc = await pdfjsLib.getDocument({
    data,
    disableFontFace: true,
  }).promise;

  const numPages = doc.numPages;
  const pageTexts: string[] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    type Item = { str: string; transform?: number[] };
    const rawItems = content.items as Item[];

    const items = [...rawItems].sort((a, b) => {
      const yA = a.transform?.[5] ?? 0;
      const yB = b.transform?.[5] ?? 0;
      const xA = a.transform?.[4] ?? 0;
      const xB = b.transform?.[4] ?? 0;
      if (Math.abs(yA - yB) > 2) return yB - yA;
      return xA - xB;
    });

    let lastY: number | null = null;
    const lineParts: string[] = [];
    const lines: string[] = [];

    for (const item of items) {
      const y = item.transform?.[5] ?? 0;
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        lines.push(lineParts.join(" ").trim());
        lineParts.length = 0;
      }
      lastY = y;
      lineParts.push(item.str);
    }
    if (lineParts.length > 0) lines.push(lineParts.join(" ").trim());
    pageTexts.push(lines.join("\n"));
  }

  return pageTexts.join("\n");
}

// ── Parsers ─────────────────────────────────────────────────────────────────

function parseP3FullText(text: string): DateDrawsMap {
  const map: DateDrawsMap = {};
  const normalized = text
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let m: RegExpExecArray | null;
  P3_RECORD_REGEX.lastIndex = 0;
  while ((m = P3_RECORD_REGEX.exec(normalized)) !== null) {
    const date = m[1]!;
    const type = m[2]!.toUpperCase() === "E" ? "e" : "m";
    const numbers = [Number(m[3]), Number(m[4]), Number(m[5])];
    if (!map[date]) map[date] = {};
    (map[date] as any)[type] = numbers;
  }
  return map;
}

function parseP4FullText(text: string): DateDrawsMap {
  const map: DateDrawsMap = {};
  const normalized = text
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\t/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let m: RegExpExecArray | null;
  P4_RECORD_REGEX.lastIndex = 0;
  while ((m = P4_RECORD_REGEX.exec(normalized)) !== null) {
    const date = m[1]!;
    const type = m[2]!.toUpperCase() === "E" ? "e" : "m";
    const numbers = [Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
    if (!map[date]) map[date] = {};
    (map[date] as any)[type] = numbers;
  }
  return map;
}

// ── Fetch con resiliencia ───────────────────────────────────────────────────

async function fetchPdfWithRetry(url: string): Promise<ArrayBuffer> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const res = await fetch(url, {
        headers: { "User-Agent": "BallBot-Auditor/2.0" },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      return await res.arrayBuffer();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(
        `[AUDITOR] ⚠️ Fetch attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${url}: ${lastError.message}`
      );

      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
      }
    }
  }

  throw new Error(`PDF fetch failed after ${MAX_RETRIES + 1} attempts: ${lastError?.message}`);
}

// ── Carga de datos desde DB ─────────────────────────────────────────────────

async function loadDbDrawsMap(game: "p3" | "p4"): Promise<DateDrawsMap> {
  const pool = getDbPool();
  const { rows } = await pool.query(
    `SELECT date, period, numbers FROM draws WHERE game = $1`,
    [game]
  );

  const map: DateDrawsMap = {};
  for (const row of rows) {
    const d = row.date as string;
    const p = row.period as "m" | "e";
    const nums: number[] = (row.numbers as string).split(",").map(Number);
    if (!map[d]) map[d] = {};
    (map[d] as any)[p] = nums;
  }
  return map;
}

// ── Motor de Auditoría ──────────────────────────────────────────────────────

export async function auditDraws(game: "p3" | "p4"): Promise<AuditReport> {
  const startTime = Date.now();
  const pdfUrl = game === "p3" ? P3_PDF_URL : P4_PDF_URL;
  const parser = game === "p3" ? parseP3FullText : parseP4FullText;

  console.log(`[AUDITOR] 🔍 Iniciando auditoría forense: ${game.toUpperCase()}`);

  try {
    // 1. Descargar y parsear PDF oficial
    const pdfBuffer = await fetchPdfWithRetry(pdfUrl);
    const pdfText = await pdfToText(pdfBuffer);
    const pdfMap = parser(pdfText);

    // 2. Cargar datos actuales de DB
    const dbMap = await loadDbDrawsMap(game);

    // 3. Conteos
    let totalPdf = 0;
    let totalDb = 0;

    for (const date of Object.keys(pdfMap)) {
      if (pdfMap[date]?.m) totalPdf++;
      if (pdfMap[date]?.e) totalPdf++;
    }

    for (const date of Object.keys(dbMap)) {
      if (dbMap[date]?.m) totalDb++;
      if (dbMap[date]?.e) totalDb++;
    }

    // 4. Comparación forense
    const missing: AuditDiscrepancy[] = [];
    const corrupted: AuditDiscrepancy[] = [];
    const extraInDb: AuditDiscrepancy[] = [];

    // 4a. Registros en PDF que faltan o difieren en DB
    for (const [date, periods] of Object.entries(pdfMap)) {
      for (const period of ["m", "e"] as const) {
        const pdfNums = periods[period];
        if (!pdfNums) continue;

        const dbNums = dbMap[date]?.[period];

        if (!dbNums) {
          // Falta en DB
          missing.push({
            date,
            period,
            type: "missing",
            pdfNumbers: pdfNums,
          });
        } else if (pdfNums.join(",") !== dbNums.join(",")) {
          // Números corruptos (no coinciden)
          corrupted.push({
            date,
            period,
            type: "corrupted",
            pdfNumbers: pdfNums,
            dbNumbers: dbNums,
          });
        }
      }
    }

    // 4b. Registros en DB que NO existen en el PDF (data fantasma)
    for (const [date, periods] of Object.entries(dbMap)) {
      for (const period of ["m", "e"] as const) {
        const dbNums = periods[period];
        if (!dbNums) continue;

        const pdfNums = pdfMap[date]?.[period];
        if (!pdfNums) {
          extraInDb.push({
            date,
            period,
            type: "extra_in_db",
            dbNumbers: dbNums,
          });
        }
      }
    }

    // Ordenar discrepancias por fecha descendente para legibilidad
    const sortByDate = (a: AuditDiscrepancy, b: AuditDiscrepancy) =>
      b.date.localeCompare(a.date);
    missing.sort(sortByDate);
    corrupted.sort(sortByDate);
    extraInDb.sort(sortByDate);

    const status =
      missing.length === 0 && corrupted.length === 0
        ? "CLEAN"
        : "DISCREPANCIES_FOUND";

    const durationMs = Date.now() - startTime;

    console.log(
      `[AUDITOR] ${status === "CLEAN" ? "✅" : "⚠️"} ${game.toUpperCase()}: ` +
        `PDF=${totalPdf} DB=${totalDb} | ` +
        `Faltantes=${missing.length} Corruptos=${corrupted.length} Extras=${extraInDb.length} | ` +
        `${durationMs}ms`
    );

    return {
      game,
      status,
      totalPdf,
      totalDb,
      missing,
      corrupted,
      extraInDb,
      durationMs,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(`[AUDITOR] ❌ Error en auditoría ${game.toUpperCase()}: ${errorMessage}`);

    return {
      game,
      status: "ERROR",
      totalPdf: 0,
      totalDb: 0,
      missing: [],
      corrupted: [],
      extraInDb: [],
      errorMessage,
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * Ejecuta auditoría completa de P3 + P4 en paralelo.
 */
export async function fullAudit(): Promise<FullAuditReport> {
  const start = Date.now();
  const [p3, p4] = await Promise.all([auditDraws("p3"), auditDraws("p4")]);
  return { p3, p4, totalDurationMs: Date.now() - start };
}

// ── Motor de Reparación ─────────────────────────────────────────────────────

/**
 * Repara las discrepancias detectadas por la auditoría.
 * Solo toca registros faltantes y corruptos. Los "extra" se reportan pero NO se eliminan.
 */
export async function repairDraws(report: AuditReport): Promise<RepairResult> {
  const startTime = Date.now();
  let inserted = 0;
  let updated = 0;
  const errors: string[] = [];

  console.log(
    `[AUDITOR] 🛠 Reparando ${report.game.toUpperCase()}: ` +
      `${report.missing.length} faltantes + ${report.corrupted.length} corruptos`
  );

  // Reparar faltantes (INSERT)
  for (const disc of report.missing) {
    try {
      await upsertDrawInDB(disc.date, report.game, disc.period, disc.pdfNumbers!);
      inserted++;
    } catch (err) {
      const msg = `INSERT ${disc.date}/${disc.period}: ${err instanceof Error ? err.message : err}`;
      console.error(`[AUDITOR] ❌ ${msg}`);
      errors.push(msg);
    }
  }

  // Reparar corruptos (UPDATE con los valores del PDF oficial)
  for (const disc of report.corrupted) {
    try {
      await upsertDrawInDB(disc.date, report.game, disc.period, disc.pdfNumbers!);
      updated++;
    } catch (err) {
      const msg = `UPDATE ${disc.date}/${disc.period}: ${err instanceof Error ? err.message : err}`;
      console.error(`[AUDITOR] ❌ ${msg}`);
      errors.push(msg);
    }
  }

  const durationMs = Date.now() - startTime;
  console.log(
    `[AUDITOR] ✅ Reparación ${report.game.toUpperCase()} completada: ` +
      `${inserted} insertados, ${updated} actualizados, ${errors.length} errores | ${durationMs}ms`
  );

  return { game: report.game, inserted, updated, errors, durationMs };
}

/**
 * Repara ambos juegos a partir de un FullAuditReport.
 */
export async function repairAll(
  fullReport: FullAuditReport
): Promise<{ p3: RepairResult; p4: RepairResult }> {
  const p3 = await repairDraws(fullReport.p3);
  const p4 = await repairDraws(fullReport.p4);
  return { p3, p4 };
}
