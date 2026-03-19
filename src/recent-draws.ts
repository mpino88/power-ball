import type { HoyResult } from "./hoy-results.js";
import { resolveLatestDraw, type DateDrawsMap } from "./draw-resolver.js";

export { type DateDrawsMap };

export function buildRecentDrawsDisplay(
  p3Map: DateDrawsMap,
  p4Map: DateDrawsMap,
  today: string,
  yesterday: string,
  hoyData: HoyResult
): string {
  const maps = { p3: p3Map, p4: p4Map };
  const dates = { today, yesterday };

  // Resolvemos los 4 slots principales usando el motor centralizado
  const mP3 = resolveLatestDraw("p3", "m", maps, dates, hoyData);
  const mP4 = resolveLatestDraw("p4", "m", maps, dates, hoyData);
  const eP3 = resolveLatestDraw("p3", "e", maps, dates, hoyData);
  const eP4 = resolveLatestDraw("p4", "e", maps, dates, hoyData);

  // El Dashboard (Portada) ya no calcula las etiquetas, solo las proyecta.
  // La asimetría positiva en la resolución de tags (🟢 HOY / 🟠 AYER) ya viene inyectada.
  const mediodiaTag = mP3.label; 
  const nocheTag = eP3.label;

  return `\n` +
    `☀️ MEDIODÍA ${mediodiaTag}\n` +
    ` 🎯 Fijo (P3): ${mP3.draw}\n` +
    ` 🎲 Corrido (P4): ${mP4.draw}\n\n` +
    `🌙 NOCHE ${nocheTag}\n` +
    ` 🎯 Fijo (P3): ${eP3.draw}\n` +
    ` 🎲 Corrido (P4): ${eP4.draw}`;
}
