
import { findWinningStrategies } from "./src/neuro-hit-engine.js";
import { warmUpCandidateCache, isCacheReady, getLastCacheUpdate } from "./src/candidate-cache.js";
import { saveHoyResult } from "./src/hoy-results.js";

async function runForensicAudit() {
  console.log("🕵️‍♂️ INICIANDO AUDITORÍA FORENSE APEX v3 (Unitary Protocol)...");

  // Mocks controlados para evitar dependencias de red/PDF en el test forense
  const mockMap = {
     "03/15/26": { m: "595", e: "391" }
  };
  const mockMapP4 = {
     "03/15/26": { m: "9601", e: "3318" }
  };

  const deps = { 
    getP3Map: async () => mockMap as any, 
    getP4Map: async () => mockMapP4 as any 
  };

  // Inyectamos resultados reales al sistema
  saveHoyResult({
    p3_m: "595",
    p3_e: "391",
    p4_m: "9601",
    p4_e: "3318"
  });

  console.log("\n--- ESCENARIO 1: CACHÉ VACÍO (FALLBACK TEST) ---");
  console.log("Estado Caché P3-M:", isCacheReady("p3", "m", "freqAnalysis") ? "✅" : "❌ (Correcto)");
  
  const start = Date.now();
  const winners = await findWinningStrategies(deps, 2);
  const duration = Date.now() - start;

  console.log(`⏱️ Tiempo de ejecución con Fallback: ${duration}ms`);
  console.log("Ganadores detectados (P3-M):", (winners as any).p3_m.map((w: any) => w.label).join(", ") || "Ninguno");

  console.log("\n--- ESCENARIO 2: CACHÉ CARGADO (APEX PERFORMANCE) ---");
  await warmUpCandidateCache(deps, 20);
  console.log("Estado Caché P3-M:", isCacheReady("p3", "m", "freqAnalysis") ? "✅" : "❌");

  const startApex = Date.now();
  const winnersApex = await findWinningStrategies(deps, 2);
  const durationApex = Date.now() - startApex;

  console.log(`⏱️ Tiempo de ejecución con Motor APEX: ${durationApex}ms`);
  console.log("Ganadores detectados (P3-M):", (winnersApex as any).p3_m.map((w: any) => w.label).join(", ") || "Ninguno");

  console.log("\n--- CONCLUSIÓN FORENSE ---");
  const identical = JSON.stringify(winners) === JSON.stringify(winnersApex);
  if (identical) {
    console.log("✅ INTEGRIDAD DE DATOS: 100% (Fallback == Caché)");
    console.log("✅ RESILIENCIA: El sistema detecta aciertos sin caché manual.");
  } else {
    console.log("❌ DISCREPANCIA DETECTADA: Revisar motor de aciertos.");
  }
}

runForensicAudit().catch(console.error);
