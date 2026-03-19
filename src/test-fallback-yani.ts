import { resolveLatestDraw, formatDigits, type DateDrawsMap } from "./draw-resolver.js";
import type { HoyResult } from "./hoy-results.js";

// --- MOCK DATA PARA SIMULACIÓN ---
const maps: { p3: DateDrawsMap; p4: DateDrawsMap } = {
  p3: {
    "03/18/26": { m: [5, 8, 5], e: [7, 5, 2] }, // AYER
    "03/19/26": { m: [1, 2, 3] },              // HOY (Solo Mediodía)
  },
  p4: {
    "03/18/26": { m: [0, 9, 7, 1], e: [3, 5, 6, 1] }, // AYER
    "03/19/26": { m: [4, 4, 4, 4] },                 // HOY (Solo Mediodía)
  }
};

const dates = { today: "03/19/26", yesterday: "03/18/26" };

console.log("🚀 SIMULACIÓN DE ESTRÉS TEMPORAL: CPD BLISS (Rama: yani)\n");

// --- ESCENARIO 1: NOCHE NO HA OCURRIDO (FALLBACK A AYER) ---
console.log("--- ESCENARIO 1: Noche de HOY vacía (Fallback a Ayer) ---");
const resNocheP3 = resolveLatestDraw("p3", "e", maps, dates, {}); // hoyData vacío
const resNocheP4 = resolveLatestDraw("p4", "e", maps, dates, {});

console.log(`NOCHE TAG: ${resNocheP3.label}`);
console.log(`P3 Result: ${resNocheP3.draw} (Expected: 7-5-2)`);
console.log(`P4 Result: ${resNocheP4.draw} (Expected: 3-5-6-1)`);
console.log(`Fallback Active: ${resNocheP3.isFallback}`);
console.log("");

// --- ESCENARIO 2: MEDIODÍA DE HOY (SÍNCRONO) ---
console.log("--- ESCENARIO 2: Mediodía de HOY disponible ---");
const resMedioP3 = resolveLatestDraw("p3", "m", maps, dates, {});
const resMedioP4 = resolveLatestDraw("p4", "m", maps, dates, {});

console.log(`MEDIO TAG: ${resMedioP3.label}`);
console.log(`P3 Result: ${resMedioP3.draw} (Expected: 1-2-3)`);
console.log(`P4 Result: ${resMedioP4.draw} (Expected: 4-4-4-4)`);
console.log(`Fallback Active: ${resMedioP3.isFallback}`);
console.log("");

// --- ESCENARIO 3: PUSH MANUAL (VERDAD FORZADA) ---
console.log("--- ESCENARIO 3: Push Manual del CEO ---");
const hoyData: HoyResult = { p3_m: "999", p3_m_date: "03/19/26" };
const resManualP3 = resolveLatestDraw("p3", "m", maps, dates, hoyData);

console.log(`MANUAL TAG: ${resManualP3.label}`);
console.log(`P3 Result: ${resManualP3.draw} (Expected: 9-9-9)`);
console.log("");

// --- TEST DE FORMATO DE DÍGITOS ---
console.log("--- TEST DE HIPHENACIÓN (FormatDigits) ---");
console.log(`Format [1,2,3]: ${formatDigits([1, 2, 3])}`);
console.log(`Format "4567": ${formatDigits("4567")}`);
console.log(`Format "---": ${formatDigits("---")}`);

console.log("\n✅ SIMULACIÓN COMPLETADA SIN DISONANCIAS.");
