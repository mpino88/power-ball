/**
 * Obtiene los resultados más recientes de Pick 3 y Pick 4 de Florida Lottery
 * mediante scraping de las páginas oficiales.
 * Fuentes:
 *   https://floridalottery.com/games/draw-games/pick-3
 *   https://floridalottery.com/games/draw-games/pick-4
 */

const PICK3_URL = "https://floridalottery.com/games/draw-games/pick-3";
const PICK4_URL = "https://floridalottery.com/games/draw-games/pick-4";
const SCRAPE_TIMEOUT_MS = 30_000;

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
  const playwright = await import("playwright");
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: SCRAPE_TIMEOUT_MS });
    const text = await page.evaluate(() => document.body.innerText);
    return text ?? "";
  } finally {
    await browser.close();
  }
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
    const isMidday = /midday|mid\s*day|1:30|1:20/i.test(block);
    const isEvening = /evening|eve|9:45|9:35/i.test(block);
    const period: DrawPeriod = isMidday ? "midday" : isEvening ? "evening" : "evening";
    const periodLabel = period === "midday" ? "Mediodía" : "Noche";

    numberRe.lastIndex = 0;
    const numMatch = numberRe.exec(block);
    if (!numMatch) continue;
    const numbers = numMatch.slice(1, 1 + numDigits).join("-");
    const fireballM = block.match(/fireball\s*[:\s]*(\d)|(\d)\s*[•·]?\s*fireball/i);
    const fireball = fireballM ? (fireballM[1] ?? fireballM[2]) : undefined;

    draws.push({
      date: dateBlocks[i].dateLabel,
      period,
      periodLabel,
      numbers,
      fireball,
    });
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
