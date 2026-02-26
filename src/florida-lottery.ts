/**
 * Obtiene resultados de Pick 3 y Pick 4 de la Florida Lottery.
 * Fuente: floridalotteryresults.com (datos alineados con los sorteos oficiales).
 * Enlaces oficiales: floridalottery.com/games/draw-games/pick-3 y pick-4
 */

const PICK3_URL = "https://floridalotteryresults.com/pick-3/";
const PICK4_URL = "https://floridalotteryresults.com/pick-4/";
const FETCH_TIMEOUT_MS = 12_000;

export type DrawPeriod = "midday" | "evening";

export interface DrawResult {
  date: string; // "Feb 16, 2026"
  period: DrawPeriod;
  periodLabel: string; // "Mediodía" / "Noche"
  numbers: string;   // "9-7-3" o "1-2-3-4"
  fireball?: string; // "7" si hay Fireball
  raw: string;       // línea cruda ej. "9737FB"
}

export interface GameResults {
  game: "Pick 3" | "Pick 4";
  draws: DrawResult[];
  link: string;
  officialLink: string;
}

function fetchWithTimeout(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    signal: controller.signal,
    headers: { "User-Agent": "FloridaLotteryBot/1.0 (Telegram)" },
  })
    .then((r) => {
      clearTimeout(timeout);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    })
    .catch((e) => {
      clearTimeout(timeout);
      throw e;
    });
}

/**
 * Parsea el HTML de floridalotteryresults.com.
 * Estructura: flrpg-date, flrpg-badge--evening|midday, flrpg-ball (dígitos), flrpg-ball flrpg-bonus (Fireball).
 */
function parseResultsPage(
  html: string,
  _game: "Pick 3" | "Pick 4",
  numDigits: 3 | 4
): DrawResult[] {
  const draws: DrawResult[] = [];
  const dateRe = /<time class="flrpg-date">([^<]+)<\/time>/g;
  const badgeRe = /flrpg-badge--(evening|midday)">[^<]*/g;
  const ballRe = /class="flrpg-ball(?:\s+flrpg-bonus)?"[^>]*>(\d)</g;

  let dateMatch: RegExpExecArray | null;
  while ((dateMatch = dateRe.exec(html)) !== null) {
    const dateLabel = dateMatch[1].trim();
    const afterDate = html.slice(dateMatch.index);
    const badgeMatch = afterDate.match(/flrpg-badge--(evening|midday)/);
    if (!badgeMatch) continue;
    const period = badgeMatch[1] as DrawPeriod;
    const periodLabel = period === "midday" ? "Mediodía" : "Noche";

    const ballSection = afterDate.slice(0, 500);
    const ballMatches = [...ballSection.matchAll(/class="flrpg-ball(\s+flrpg-bonus)?"[^>]*>(\d)</g)];
    const mainBalls = ballMatches
      .filter((m) => !m[1]) // sin flrpg-bonus
      .slice(0, numDigits)
      .map((m) => m[2]);
    const bonusBall = ballMatches.find((m) => m[1])?.[2]; // el que tiene flrpg-bonus
    if (mainBalls.length !== numDigits) continue;

    const numbers = mainBalls.join("-");
    const raw = mainBalls.join("") + (bonusBall ?? "") + (bonusBall ? "FB" : "");

    draws.push({
      date: dateLabel,
      period,
      periodLabel,
      numbers,
      fireball: bonusBall,
      raw,
    });
  }
  return draws;
}

const FLORIDA_TZ = "America/New_York";

const MONTHS = "Jan,Feb,Mar,Apr,May,Jun,Jul,Aug,Sep,Oct,Nov,Dec".split(",");

export function formatDateForLabel(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

/** Fecha de hoy en hora de Florida (para que "Hoy" coincida con el día en EE.UU.). */
function getTodayInFlorida(): string {
  return new Date().toLocaleDateString("en-US", {
    timeZone: FLORIDA_TZ,
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Fecha de ayer en hora de Florida (usa UTC para no depender del timezone del servidor). */
function getYesterdayInFlorida(): string {
  const todayStr = new Date().toLocaleDateString("en-CA", { timeZone: FLORIDA_TZ }); // YYYY-MM-DD
  const [y, m, d] = todayStr.split("-").map(Number);
  const yesterdayMs = Date.UTC(y, m - 1, d) - 86400000;
  const yesterday = new Date(yesterdayMs);
  const month = yesterday.getUTCMonth();
  const day = yesterday.getUTCDate();
  const year = yesterday.getUTCFullYear();
  return `${MONTHS[month]} ${day}, ${year}`;
}

/** Convierte "Feb 16, 2026" a "2026-02-16" para comparar. */
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

/** Filtra sorteos por fecha (hoy, ayer o fecha concreta). */
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
  const list = byDate.get(
    draws.find((d) => dateLabelToYMD(d.date) === targetYMD)?.date ?? ""
  );
  if (!list || list.length === 0) return [];
  const evening = list.find((d) => d.period === "evening");
  const midday = list.find((d) => d.period === "midday");
  return [evening, midday].filter(Boolean) as DrawResult[];
}

/**
 * Obtiene resultados de Pick 3 para la fecha indicada (hoy, ayer o fecha custom).
 */
export async function fetchPick3Results(dateFilter: DateFilter = "today"): Promise<GameResults> {
  const html = await fetchWithTimeout(PICK3_URL);
  const allDraws = parseResultsPage(html, "Pick 3", 3);
  const draws = getDrawsForDate(allDraws, dateFilter);
  return {
    game: "Pick 3",
    draws,
    link: PICK3_URL,
    officialLink: "https://floridalottery.com/games/draw-games/pick-3",
  };
}

/**
 * Obtiene resultados de Pick 4 para la fecha indicada (hoy, ayer o fecha custom).
 */
export async function fetchPick4Results(dateFilter: DateFilter = "today"): Promise<GameResults> {
  const html = await fetchWithTimeout(PICK4_URL);
  const allDraws = parseResultsPage(html, "Pick 4", 4);
  const draws = getDrawsForDate(allDraws, dateFilter);
  return {
    game: "Pick 4",
    draws,
    link: PICK4_URL,
    officialLink: "https://floridalottery.com/games/draw-games/pick-4",
  };
}

/**
 * Formatea resultados para mostrar en el bot.
 * @param titleOverride Si se indica (ej. "Resultados de ayer"), se usa en lugar del título por defecto.
 */
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
