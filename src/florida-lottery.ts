/**
 * Obtiene resultados de Pick 3 y Pick 4 de la Florida Lottery.
 * Fuente: PDF oficial (todas las páginas). Formato en PDF: MM/DD/YY E #-#-# o MM/DD/YY M #-#-#
 * Enlaces oficiales: files.floridalottery.com/exptkt/p3.pdf y p4.pdf
 */

const PICK3_PDF_URL = "https://files.floridalottery.com/exptkt/p3.pdf";
const PICK4_PDF_URL = "https://files.floridalottery.com/exptkt/p4.pdf";
const FETCH_TIMEOUT_MS = 25_000;

export type DrawPeriod = "midday" | "evening";

export interface DrawResult {
  date: string; // "Feb 16, 2026"
  period: DrawPeriod;
  periodLabel: string;
  numbers: string;
  fireball?: string;
  raw: string;
}

export interface GameResults {
  game: "Pick 3" | "Pick 4";
  draws: DrawResult[];
  link: string;
  officialLink: string;
}

const MONTHS = "Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec".split(",");

/** Convierte MM/DD/YY a "Feb 16, 2026". */
function pdfDateToLabel(mm: string, dd: string, yy: string): string {
  const month = parseInt(mm, 10);
  const day = parseInt(dd, 10);
  let year = parseInt(yy, 10);
  if (year >= 0 && year <= 99) year = year >= 50 ? 1900 + year : 2000 + year;
  return `${MONTHS[month - 1]} ${day}, ${year}`;
}

/**
 * Parsea el texto extraído del PDF. Busca líneas con formato:
 * MM/DD/YY E #-#-# (evening) o MM/DD/YY M #-#-# (midday)
 * Para Pick 4: #-#-#-# (cuatro números).
 */
function parsePdfText(text: string, numDigits: 3 | 4): DrawResult[] {
  const draws: DrawResult[] = [];
  const pattern =
    numDigits === 3
      ? /(\d{2})\/(\d{2})\/(\d{2})\s+([EM])\s+(\d)\s*-\s*(\d)\s*-\s*(\d)/g
      : /(\d{2})\/(\d{2})\/(\d{2})\s+([EM])\s+(\d)\s*-\s*(\d)\s*-\s*(\d)\s*-\s*(\d)/g;

  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const dateLabel = pdfDateToLabel(m[1], m[2], m[3]);
    const period: DrawPeriod = m[4].toUpperCase() === "E" ? "evening" : "midday";
    const periodLabel = period === "midday" ? "Mediodía" : "Noche";
    const numbers = m.slice(5, 5 + numDigits).join("-");
    const raw = m[0];

    draws.push({
      date: dateLabel,
      period,
      periodLabel,
      numbers,
      raw,
    });
  }
  return draws;
}

function fetchPdfAsBuffer(url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    signal: controller.signal,
    headers: { "User-Agent": "FloridaLotteryBot/1.0 (Telegram)" },
  })
    .then((r) => {
      clearTimeout(timeout);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .then((ab) => Buffer.from(ab))
    .catch((e) => {
      clearTimeout(timeout);
      throw e;
    });
}

async function extractTextFromPdf(buffer: Buffer): Promise<string> {
  const pdfParse = (await import("pdf-parse")).default as (
    buffer: Buffer
  ) => Promise<{ text: string }>;
  const data = await pdfParse(buffer);
  return data.text ?? "";
}

const FLORIDA_TZ = "America/New_York";

export function formatDateForLabel(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function getTodayInFlorida(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: FLORIDA_TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function getYesterdayInFlorida(): string {
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: FLORIDA_TZ });
  const [y, m, d] = todayStr.split("-").map(Number);
  const yesterdayMs = Date.UTC(y, m - 1, d) - 86400000;
  const yesterday = new Date(yesterdayMs);
  return `${MONTHS[yesterday.getUTCMonth()]} ${yesterday.getUTCDate()}, ${yesterday.getUTCFullYear()}`;
}

function dateLabelToYMD(label: string): string {
  const d = new Date(label);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export type DateFilter = "today" | "yesterday" | Date;

function getYMDForFilter(filter: DateFilter): string {
  if (filter === "today") return dateLabelToYMD(getTodayInFlorida());
  if (filter === "yesterday") return dateLabelToYMD(getYesterdayInFlorida());
  const d = filter instanceof Date ? filter : new Date(filter);
  if (Number.isNaN(d.getTime())) return "";
  return dateLabelToYMD(formatDateForLabel(d));
}

function getDrawsForDate(draws: DrawResult[], filter: DateFilter): DrawResult[] {
  const targetYMD = getYMDForFilter(filter);
  if (!targetYMD) return [];
  const byDate = new Map<string, DrawResult[]>();
  for (const d of draws) {
    const ymd = dateLabelToYMD(d.date);
    if (ymd !== targetYMD) continue;
    const list = byDate.get(d.date) ?? [];
    list.push(d);
    byDate.set(d.date, list);
  }
  const firstMatch = draws.find((d) => dateLabelToYMD(d.date) === targetYMD);
  const list = firstMatch ? byDate.get(firstMatch.date) : undefined;
  if (!list || list.length === 0) return [];
  const evening = list.find((d) => d.period === "evening");
  const midday = list.find((d) => d.period === "midday");
  return [evening, midday].filter(Boolean) as DrawResult[];
}

/**
 * Descarga el PDF oficial, extrae el texto de todas las páginas y parsea los resultados.
 */
export async function fetchPick3Results(dateFilter: DateFilter = "today"): Promise<GameResults> {
  const buffer = await fetchPdfAsBuffer(PICK3_PDF_URL);
  const text = await extractTextFromPdf(buffer);
  const allDraws = parsePdfText(text, 3);
  const draws = getDrawsForDate(allDraws, dateFilter);
  return {
    game: "Pick 3",
    draws,
    link: PICK3_PDF_URL,
    officialLink: "https://floridalottery.com/games/draw-games/pick-3",
  };
}

export async function fetchPick4Results(dateFilter: DateFilter = "today"): Promise<GameResults> {
  const buffer = await fetchPdfAsBuffer(PICK4_PDF_URL);
  const text = await extractTextFromPdf(buffer);
  const allDraws = parsePdfText(text, 4);
  const draws = getDrawsForDate(allDraws, dateFilter);
  return {
    game: "Pick 4",
    draws,
    link: PICK4_PDF_URL,
    officialLink: "https://floridalottery.com/games/draw-games/pick-4",
  };
}

export function formatResultsForBot(
  data: GameResults,
  titleOverride?: string
): string {
  const todayLabel = getTodayInFlorida();
  let title = titleOverride;
  if (!title) {
    const isToday = data.draws.some((d) => d.date === todayLabel);
    title = isToday ? `Resultados de hoy — ${data.game}` : `Resultados — ${data.game}`;
  }
  let body = "";
  for (const d of data.draws) {
    const fb = d.fireball ? ` • Fireball: ${d.fireball}` : "";
    body += `\n${d.periodLabel === "Mediodía" ? "☀️" : "🌙"} *${d.periodLabel}* (${d.date})\n\`${d.numbers}\`${fb}\n`;
  }
  if (data.draws.length === 0) body = "\n_No hay resultados para esa fecha._";
  body += `\n[Ver en Florida Lottery](${data.officialLink})`;
  return `*${title}*\n${body.trim()}`;
}
