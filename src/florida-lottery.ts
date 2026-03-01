/**
 * Obtiene los resultados más recientes de Pick 3 y Pick 4 de Florida Lottery
 * mediante scraping de las páginas oficiales.
 * Fuentes:
 *   https://floridalottery.com/games/draw-games/pick-3
 *   https://floridalottery.com/games/draw-games/pick-4
 *
 * Para "Hoy" se usa la sección game-numbers (pick3/pick4) y draw-date para verificar fecha.
 */

const PICK3_URL = "https://floridalottery.com/games/draw-games/pick-3";
const PICK4_URL = "https://floridalottery.com/games/draw-games/pick-4";
const SCRAPE_TIMEOUT_MS = 30_000;

/** Resultado del scraping de "hoy": fecha de la web y sorteos M/E si la fecha coincide con hoy. */
export interface TodayScrapeResult {
  /** Si la fecha mostrada en la web coincide con el día de hoy (Florida). */
  isToday: boolean;
  /** Fecha en formato MM/DD/YY tal como se muestra o se infiere. */
  key: string;
  m?: number[];
  e?: number[];
}

export type DrawPeriod = "midday" | "evening";

export interface DrawResult {
  date: string;
  period: DrawPeriod;
  periodLabel: string;
  numbers: string;
  fireball?: string;
  raw?: string;
}

export interface GameResults {
  game: "Pick 3" | "Pick 4";
  draws: DrawResult[];
  officialLink: string;
}

async function getPageText(url: string): Promise<string> {
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.default.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle0", timeout: SCRAPE_TIMEOUT_MS });
    const text = await page.evaluate(() => document.body.innerText);
    return text ?? "";
  } finally {
    await browser.close();
  }
}

/** Parsea texto de fecha de la web (ej: "Wed, Feb 25, 2026" o "02/25/26") a MM/DD/YY. */
function parseDrawDateToMMDDYY(dateText: string): string | null {
  const t = dateText.trim();
  if (!t) return null;
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/;
  const mSlash = t.match(slash);
  if (mSlash) {
    const mm = mSlash[1]!.padStart(2, "0");
    const dd = mSlash[2]!.padStart(2, "0");
    const yy = mSlash[3]!.length === 2 ? mSlash[3] : mSlash[3]!.slice(-2);
    return `${mm}/${dd}/${yy}`;
  }
  const months: Record<string, string> = {
    jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
    jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  };
  const long = /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s*(\d{4})/i;
  const short = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})/i;
  let match = t.match(long) ?? t.match(short);
  if (match) {
    const monthKey = match[1]!.slice(0, 3).toLowerCase();
    const mm = months[monthKey];
    if (!mm) return null;
    const dd = match[2]!.padStart(2, "0");
    const yy = match[3]!.slice(-2);
    return `${mm}/${dd}/${yy}`;
  }
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${mm}/${dd}/${yy}`;
}

/**
 * Extrae de la página los datos para "Hoy": fecha (draw-date--pick3/pick4) y números (game-numbers).
 * Usa la estructura: ul.game-numbers.game-numbers--pick3/pick4 con li.game-numbers__number span (sin Fireball).
 * Primer bloque = Mediodía (M), segundo = Noche (E).
 */
async function scrapeTodayFromPage(
  url: string,
  dateClass: "draw-date--pick3" | "draw-date--pick4",
  numbersClass: "game-numbers--pick3" | "game-numbers--pick4",
  numDigits: 3 | 4
): Promise<TodayScrapeResult> {
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.default.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: SCRAPE_TIMEOUT_MS });
    const raw = await page.evaluate(
      (args: { dateClass: string; numbersClass: string; numDigits: number }) => {
        const dateEl = document.querySelector(`.${args.dateClass}`);
        const dateText = dateEl?.textContent?.trim() ?? "";
        const uls = document.querySelectorAll(`ul.game-numbers.${args.numbersClass}`);
        const numberArrays: number[][] = [];
        uls.forEach((ul) => {
          const items = ul.querySelectorAll("li.game-numbers__number span");
          const digits: number[] = [];
          items.forEach((span) => {
            const t = span.textContent?.trim();
            if (t && /^\d$/.test(t)) digits.push(Number(t));
          });
          if (digits.length === args.numDigits) numberArrays.push(digits);
        });
        return { dateText, numberArrays };
      },
      { dateClass, numbersClass, numDigits }
    );
    const key = parseDrawDateToMMDDYY(raw.dateText) ?? "";
    const todayFlorida = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
    const [y, m, d] = todayFlorida.split("-");
    const todayKey = `${m}/${d}/${y!.slice(-2)}`;
    const isToday = key === todayKey;

    const result: TodayScrapeResult = { isToday, key: key || todayKey };
    if (raw.numberArrays[0]?.length === numDigits) result.m = raw.numberArrays[0];
    if (raw.numberArrays[1]?.length === numDigits) result.e = raw.numberArrays[1];
    return result;
  } finally {
    await browser.close();
  }
}

/**
 * Scrapea Pick 3 "Hoy" desde la web. Compara draw-date--pick3 con el día actual (Florida).
 * Si la fecha no coincide, isToday será false (mostrar "No hay datos disponible aún").
 */
export async function scrapeTodayPick3(): Promise<TodayScrapeResult> {
  return scrapeTodayFromPage(PICK3_URL, "draw-date--pick3", "game-numbers--pick3", 3);
}

/**
 * Scrapea Pick 4 "Hoy" desde la web. Compara draw-date--pick4 con el día actual (Florida).
 * Si la fecha no coincide, isToday será false (mostrar "No hay datos disponible aún").
 */
export async function scrapeTodayPick4(): Promise<TodayScrapeResult> {
  return scrapeTodayFromPage(PICK4_URL, "draw-date--pick4", "game-numbers--pick4", 4);
}

/**
 * Parsea el texto de la página buscando bloques "fecha + periodo + números + fireball".
 * La sección de resultados suele tener fechas tipo "WED, FEB 25, 2026" y Midday/Evening.
 */
function parsePageTextForDraws(text: string, numDigits: 3 | 4): DrawResult[] {
  const draws: DrawResult[] = [];
  const monthNames: Record<string, string> = {
    JAN: "Jan", FEB: "Feb", MAR: "Mar", APR: "Apr", MAY: "May", JUN: "Jun",
    JUL: "Jul", AUG: "Aug", SEP: "Sep", OCT: "Oct", NOV: "Nov", DEC: "Dec",
  };
  const dateRe = /([A-Z]{3}),\s*([A-Z]{3})\s+(\d{1,2}),\s*(\d{4})/g;
  const numberRe =
    numDigits === 3
      ? /\b(\d)\s*[\s\-]*(\d)\s*[\s\-]*(\d)\b/g
      : /\b(\d)\s*[\s\-]*(\d)\s*[\s\-]*(\d)\s*[\s\-]*(\d)\b/g;

  let dateMatch: RegExpExecArray | null;
  const dateBlocks: Array<{ index: number; dateLabel: string }> = [];
  while ((dateMatch = dateRe.exec(text)) !== null) {
    const monthKey = dateMatch[2].toUpperCase();
    if (monthNames[monthKey]) {
      dateBlocks.push({
        index: dateMatch.index,
        dateLabel: `${monthNames[monthKey]} ${dateMatch[3]}, ${dateMatch[4]}`,
      });
    }
  }

  for (let i = 0; i < dateBlocks.length; i++) {
    const start = dateBlocks[i].index;
    const end = dateBlocks[i + 1]?.index ?? text.length;
    const block = text.slice(start, end);
    const dateLabel = dateBlocks[i].dateLabel;

    numberRe.lastIndex = 0;
    let numMatch: RegExpExecArray | null;
    while ((numMatch = numberRe.exec(block)) !== null) {
      const numbers = numMatch.slice(1, 1 + numDigits).join("-");
      const textBeforeMatch = block.slice(0, numMatch.index);
      const middayMatches = [...textBeforeMatch.matchAll(/\b(?:midday|mid\s*day|1:30|1:20)\b/gi)];
      const eveningMatches = [...textBeforeMatch.matchAll(/\b(?:evening|eve|9:45|9:35)\b/gi)];
      const lastMiddayIdx = middayMatches.length ? middayMatches[middayMatches.length - 1].index! : -1;
      const lastEveningIdx = eveningMatches.length ? eveningMatches[eveningMatches.length - 1].index! : -1;
      let period: DrawPeriod;
      if (lastMiddayIdx >= 0 && lastEveningIdx >= 0) {
        period = lastEveningIdx > lastMiddayIdx ? "evening" : "midday";
      } else if (lastMiddayIdx >= 0) {
        period = "midday";
      } else {
        period = "evening";
      }
      const periodLabel = period === "midday" ? "Mediodía" : "Noche";
      const fireballM = block.slice(numMatch.index).match(/fireball\s*[:\s]*(\d)|(\d)\s*[•·]?\s*fireball/i);
      const fireball = fireballM ? (fireballM[1] ?? fireballM[2]) : undefined;

      draws.push({
        date: dateLabel,
        period,
        periodLabel,
        numbers,
        fireball,
      });
    }
  }

  return draws;
}

/**
 * Scrapea la página de Pick 3 y devuelve los resultados más recientes mostrados.
 */
export async function fetchPick3RecentResults(): Promise<GameResults> {
  const text = await getPageText(PICK3_URL);
  const draws = parsePageTextForDraws(text, 3);
  return {
    game: "Pick 3",
    draws,
    officialLink: PICK3_URL,
  };
}

/**
 * Scrapea la página de Pick 4 y devuelve los resultados más recientes (incl. Fireball).
 */
export async function fetchPick4RecentResults(): Promise<GameResults> {
  const text = await getPageText(PICK4_URL);
  const draws = parsePageTextForDraws(text, 4);
  return {
    game: "Pick 4",
    draws,
    officialLink: PICK4_URL,
  };
}

/**
 * Formatea los resultados para el mensaje del bot.
 */
export function formatResultsForBot(data: GameResults, titleOverride?: string): string {
  const title = titleOverride ?? `Resultados recientes — ${data.game}`;
  let body = "";
  for (const d of data.draws) {
    const fb = d.fireball ? ` • Fireball: ${d.fireball}` : "";
    body += `\n${d.periodLabel === "Mediodía" ? "☀️" : "🌙"} *${d.periodLabel}* (${d.date})\n\`${d.numbers}\`${fb}\n`;
  }
  if (data.draws.length === 0)
    body = "\n_No se pudieron obtener resultados. Prueba más tarde._";
  body += `\n[Ver en Florida Lottery](${data.officialLink})`;
  return `*${title}*\n${body.trim()}`;
}
