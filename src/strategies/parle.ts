/**
 * Parlé — Generador de combinaciones de 2 sin repetición.
 *
 * Dado un array de números candidatos (como los que producen las estrategias),
 * genera todas las combinaciones C(n,2) posibles sin repetir ningún par.
 *
 * Ejemplo:
 *   Entrada : [13, 24, 56]
 *   Salida  : 13 => 24 · 13 => 56 · 24 => 56   (3 combinaciones)
 *
 * Límite práctico: se usan los primeros MAX_PARLE_NUMS números para mantener
 * el mensaje dentro del límite de Telegram (4096 chars).
 *   · 10 números →  45 combinaciones  ≈  540 chars
 *   · 15 números → 105 combinaciones  ≈ 1260 chars
 *   · 20 números → 190 combinaciones  ≈ 2280 chars  (límite por defecto)
 */

import type { StrategyContext } from "./types.js";

export const MAX_PARLE_NUMS = 20;

/** Prefijo de callback para el botón "Hacer parlé" de una estrategia individual. */
export const PARLE_CALLBACK_PREFIX = "parle_";

/** Callback especial para el parlé del resultado del Consenso Multi-Estrategia. */
export const PARLE_CNS_CALLBACK = "parle_cns";

/** Genera todas las combinaciones C(n,2) de un array sin repetición. */
export function generatePairs(nums: number[]): [number, number][] {
  const pairs: [number, number][] = [];
  for (let i = 0; i < nums.length; i++) {
    for (let j = i + 1; j < nums.length; j++) {
      pairs.push([nums[i]!, nums[j]!]);
    }
  }
  return pairs;
}

/**
 * Construye el mensaje con todas las combinaciones parlé en formato Telegram Markdown.
 *
 * @param nums     Números candidatos (se limitan a MAX_PARLE_NUMS).
 * @param label    Nombre de la estrategia fuente.
 * @param context  Contexto (P3/P4, M/E) para la cabecera.
 */
export function buildParleMessage(
  nums: number[],
  label: string,
  context: StrategyContext
): string {
  const periodLabel = context.period === "m" ? "☀️ Mediodía" : "🌙 Noche";
  const mapLabel = context.mapSource === "p3" ? "P3 (Fijos)" : "P4 (Corridos)";

  const limited = nums.slice(0, MAX_PARLE_NUMS);
  const truncated = nums.length > MAX_PARLE_NUMS;
  const pairs = generatePairs(limited);

  if (limited.length < 2) {
    return (
      `🎰 *Parlé — ${label}* — ${mapLabel} · ${periodLabel}\n\n` +
      `_Sin candidatos suficientes para generar combinaciones \\(necesita al menos 2 números\\)\\._`
    );
  }

  const numsStr = limited.map((n) => String(n).padStart(2, "0")).join(" · ");

  const lines: string[] = [
    `🎰 *Parlé — ${label}*`,
    `${mapLabel} · ${periodLabel}`,
    ``,
    `📌 _Números base (${limited.length}${truncated ? ` de ${nums.length}, limitado a ${MAX_PARLE_NUMS}` : ""}):_`,
    `\`${numsStr}\``,
    ``,
    `🔢 _${pairs.length} combinación${pairs.length !== 1 ? "es" : ""} de 2 (C(${limited.length},2)):_`,
    ``,
    "```",
  ];

  for (const [a, b] of pairs) {
    lines.push(`${String(a).padStart(2, "0")} => ${String(b).padStart(2, "0")}`);
  }

  lines.push("```");

  if (truncated) {
    lines.push(`_⚠️ Limitado a los primeros ${MAX_PARLE_NUMS} números._`);
  }

  const full = lines.join("\n");
  return full.length > 4000 ? full.slice(0, 3985) + "\n\n_… (recortado)_" : full;
}

/**
 * Construye el callback data para el botón parlé de una estrategia individual.
 * Formato: parle_<menuId>_<p3|p4>_<m|e>
 * Máx. 64 bytes (límite Telegram); los IDs más largos: max_per_week_day → 32 chars ✓
 */
export function buildParleCallback(
  menuId: string,
  mapSource: "p3" | "p4",
  period: "m" | "e"
): string {
  return `${PARLE_CALLBACK_PREFIX}${menuId}_${mapSource}_${period}`;
}

/**
 * Parsea un callback data de parlé individual.
 * Retorna null si el dato no corresponde a este formato.
 */
export function parseParleCallback(
  data: string
): { menuId: string; context: StrategyContext } | null {
  if (!data.startsWith(PARLE_CALLBACK_PREFIX)) return null;
  if (data === PARLE_CNS_CALLBACK) return null; // caso especial del consenso

  const rest = data.slice(PARLE_CALLBACK_PREFIX.length);
  const parts = rest.split("_");
  if (parts.length < 3) return null;

  const period = parts[parts.length - 1];
  const mapSource = parts[parts.length - 2];
  if (mapSource !== "p3" && mapSource !== "p4") return null;
  if (period !== "m" && period !== "e") return null;

  const menuId = parts.slice(0, -2).join("_");
  if (!menuId) return null;

  return {
    menuId,
    context: { mapSource: mapSource as "p3" | "p4", period: period as "m" | "e" },
  };
}
