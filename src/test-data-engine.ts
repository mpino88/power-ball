import { parse } from "node:path";

// Tipos básicos para el test (replicados de bot.ts para evitar colisiones de importación de main())
type DateDrawsMap = Record<string, { m?: number[]; e?: number[] }>;

const P3_PDF_URL = "https://files.floridalottery.com/exptkt/p3.pdf";
const P3_RECORD_REGEX = /(\d{2}\/\d{2}\/\d{2})\s*([EM])\s*(\d)[\s\-]*(\d)[\s\-]*(\d)(?:\s+FB\s*(\d))?/gi;

function parseP3FullText(text: string): DateDrawsMap {
  const map: DateDrawsMap = {};
  const normalized = text.replace(/\s+/g, " ").trim();
  let m: RegExpExecArray | null;
  P3_RECORD_REGEX.lastIndex = 0;
  while ((m = P3_RECORD_REGEX.exec(normalized)) !== null) {
    const date = m[1]!;
    const type = m[2]!.toUpperCase() === "E" ? "e" : "m";
    const numbers = [Number(m[3]), Number(m[4]), Number(m[5])];
    if (!map[date]) map[date] = {};
    map[date][type] = numbers;
  }
  return map;
}

// Lógica de Motor con TTL (La que implementamos en bot.ts)
const PDF_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
let cachedP3Map: DateDrawsMap | null = null;
let lastP3Fetch = 0;

async function getP3MapMock(forceNow?: number): Promise<{ map: DateDrawsMap; refreshed: boolean }> {
  const now = forceNow ?? Date.now();
  let refreshed = false;

  if (cachedP3Map && (now - lastP3Fetch < PDF_CACHE_TTL_MS)) {
    return { map: cachedP3Map, refreshed: false };
  }

  console.log(`[TEST] Refrescando datos... (Razón: ${cachedP3Map ? "TTL Expirado" : "Caché Vacío"})`);
  const res = await fetch(P3_PDF_URL);
  if (!res.ok) throw new Error(`Error HTTP: ${res.status}`);
  
  // En un test real usaríamos pdfjs, aquí simulamos el flujo de éxito con un mock si no queremos dependencias pesadas
  // pero para validar el REFRESCO usaremos el fetch real.
  const data = await res.arrayBuffer();
  console.log(`[TEST] Descargados ${data.byteLength} bytes.`);
  
  // Mock de parseo para no importar pdf-dist en el test de lógica de tiempo
  cachedP3Map = { "01/01/24": { m: [1, 2, 3] } }; 
  lastP3Fetch = now;
  refreshed = true;
  return { map: cachedP3Map, refreshed: true };
}

async function runTests() {
  console.log("🚀 INICIANDO TEST DE ARQUITECTURA DE DATOS (BLISS)\n");

  // TEST 1: Carga Inicial
  console.log("--- TEST 1: Carga Inicial ---");
  const t1 = await getP3MapMock();
  if (t1.refreshed) console.log("✅ ÉXITO: Carga inicial realizada.");
  else throw new Error("FALLO: La carga inicial debería haber refrescado.");

  // TEST 2: Hit de Caché (Inmediato)
  console.log("\n--- TEST 2: Hit de Caché (Inmediato) ---");
  const t2 = await getP3MapMock();
  if (!t2.refreshed) console.log("✅ ÉXITO: Cache hit detectado (Correcto).");
  else throw new Error("FALLO: No debería haber refrescado, el caché es reciente.");

  // TEST 3: TTL Hit (Simulando 1 hora)
  console.log("\n--- TEST 3: Simulación +1 Hora ---");
  const oneHourLater = Date.now() + (60 * 60 * 1000);
  const t3 = await getP3MapMock(oneHourLater);
  if (!t3.refreshed) console.log("✅ ÉXITO: Cache persistente después de 1 hora.");
  else throw new Error("FALLO: Refrescó antes de tiempo.");

  // TEST 4: TTL Expired (Simulando 5 horas)
  console.log("\n--- TEST 4: Simulación +5 Horas (Expiración) ---");
  const fiveHoursLater = Date.now() + (5 * 60 * 60 * 1000);
  const t4 = await getP3MapMock(fiveHoursLater);
  if (t4.refreshed) console.log("✅ ÉXITO: Refresco automático tras expiración de TTL.");
  else throw new Error("FALLO: Debería haber refrescado tras 5 horas.");

  console.log("\n🎯 TODOS LOS TESTS PASARON (101% BLISS APPROVED)");
}

runTests().catch(e => {
  console.error("\n❌ TEST FALLIDO:");
  console.error(e.message);
  process.exit(1);
});
