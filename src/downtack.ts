/**
 * Cliente para la API de DOWNTACK (resultados de lotería US).
 * Docs: https://downtack.com/en/docs/us-lotteries.html
 * Florida incluye Pick 3 y Pick 4. Autenticación: api_key en query.
 *
 * Variables de entorno:
 *   DOWNTACK_API_KEY (obligatoria) — API key; contacto: hola@downtack.com
 *   DOWNTACK_API_BASE_URL (opcional) — por defecto https://api.downtack.com
 */

import type { DateDrawsMap, Pick3Numbers } from "./bot.js";

const DEFAULT_BASE = "https://api.downtack.com";
const FLORIDA_STATE = "FL";

type DowntackNumber = { value: string; order: number; specialBall?: unknown };
type DowntackDraw = { date?: string; numbers?: DowntackNumber[] };
type DowntackPlay = { name: string; draws?: DowntackDraw[] };
type DowntackGame = { name: string; plays?: DowntackPlay[] };

function getApiBase(): string {
  return process.env.DOWNTACK_API_BASE_URL ?? DEFAULT_BASE;
}

function normalizeDateMMDDYY(dateStr: string): string {
  if (!dateStr) return "";
  const parts = dateStr.trim().split("/");
  if (parts.length !== 3) return dateStr;
  const [mm, dd, yy] = parts;
  const year = yy!.length === 4 ? yy!.slice(-2) : yy;
  return `${mm!.padStart(2, "0")}/${dd!.padStart(2, "0")}/${year}`;
}

function playNameToPeriod(playName: string): "m" | "e" | null {
  const n = playName.toLowerCase();
  if (n === "midday" || n === "morning" || n === "mid") return "m";
  if (n === "evening" || n === "eve") return "e";
  return null;
}

/**
 * Obtiene los juegos de Florida desde DOWNTACK.
 * Requiere DOWNTACK_API_KEY en el entorno.
 */
export async function fetchFloridaGames(): Promise<DowntackGame[]> {
  const apiKey = process.env.DOWNTACK_API_KEY;
  if (!apiKey) {
    throw new Error("DOWNTACK_API_KEY no configurada. Obtén una en hola@downtack.com o en tu panel.");
  }
  const base = getApiBase().replace(/\/$/, "");
  const url = `${base}/get-games-by-state/${FLORIDA_STATE}?api_key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`DOWNTACK API error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

/**
 * Extrae del response de DOWNTACK el mapa fecha → { e?, m? } para Pick 3 (3 números).
 */
export function buildPick3MapFromDowntackGames(games: DowntackGame[]): DateDrawsMap {
  const map: DateDrawsMap = {};
  const pick3 = games.find((g) => /pick\s*3/i.test(g.name));
  if (!pick3?.plays) return map;

  for (const play of pick3.plays) {
    const period = playNameToPeriod(play.name);
    if (!period || !play.draws) continue;
    for (const draw of play.draws) {
      const date = draw.date ? normalizeDateMMDDYY(draw.date) : "";
      if (!date) continue;
      const nums = (draw.numbers ?? [])
        .filter((n) => !n.specialBall)
        .sort((a, b) => a.order - b.order)
        .slice(0, 3)
        .map((n) => Number(n.value));
      if (nums.length !== 3) continue;
      if (!map[date]) map[date] = {};
      map[date][period] = nums as Pick3Numbers;
    }
  }
  return map;
}

/**
 * Obtiene los resultados históricos (o últimos disponibles) de Florida Pick 3 desde DOWNTACK.
 * Devuelve el mapa fecha → { m?, e? } con los 3 números por sorteo.
 */
export async function fetchFloridaPick3FromDowntack(): Promise<DateDrawsMap> {
  const games = await fetchFloridaGames();
  return buildPick3MapFromDowntackGames(games);
}

/** Mapa fecha → { m?, e? } con 4 números (Pick 4). */
export type Pick4DateDrawsMap = Record<string, { m?: [number, number, number, number]; e?: [number, number, number, number] }>;

function buildPick4MapFromDowntackGames(games: DowntackGame[]): Pick4DateDrawsMap {
  const map: Pick4DateDrawsMap = {};
  const pick4 = games.find((g) => /pick\s*4/i.test(g.name));
  if (!pick4?.plays) return map;

  for (const play of pick4.plays) {
    const period = playNameToPeriod(play.name);
    if (!period || !play.draws) continue;
    for (const draw of play.draws) {
      const date = draw.date ? normalizeDateMMDDYY(draw.date) : "";
      if (!date) continue;
      const nums = (draw.numbers ?? [])
        .filter((n) => !n.specialBall)
        .sort((a, b) => a.order - b.order)
        .slice(0, 4)
        .map((n) => Number(n.value));
      if (nums.length !== 4) continue;
      if (!map[date]) map[date] = {};
      map[date][period] = nums as [number, number, number, number];
    }
  }
  return map;
}

/**
 * Obtiene los resultados de Florida Pick 4 desde DOWNTACK.
 */
export async function fetchFloridaPick4FromDowntack(): Promise<Pick4DateDrawsMap> {
  const games = await fetchFloridaGames();
  return buildPick4MapFromDowntackGames(games);
}
