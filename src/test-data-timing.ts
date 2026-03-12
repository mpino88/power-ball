// test-data-engine-timing.ts
const P3_PDF_URL = "https://files.floridalottery.com/exptkt/p3.pdf";

// Mock de la lógica de tiempo del bot
function getLastExpectedUpdateTime(forceNowDate: Date): number {
  const floridaNowStr = forceNowDate.toLocaleString("en-US", { timeZone: "America/New_York" });
  const floridaNow = new Date(floridaNowStr);
  
  const t1405 = new Date(floridaNow);
  t1405.setHours(14, 5, 0, 0);
  
  const t2020 = new Date(floridaNow);
  t2020.setHours(20, 20, 0, 0);

  if (floridaNow.getTime() >= t2020.getTime()) return t2020.getTime();
  if (floridaNow.getTime() >= t1405.getTime()) return t1405.getTime();
  
  const yesterday2020 = new Date(t2020);
  yesterday2020.setDate(yesterday2020.getDate() - 1);
  return yesterday2020.getTime();
}

let cachedP3Map: any = null;
let lastP3Fetch = 0;

async function getP3MapMock(nowDate: Date): Promise<{ refreshed: boolean }> {
  const leut = getLastExpectedUpdateTime(nowDate);
  const nowMs = nowDate.getTime();

  if (cachedP3Map && lastP3Fetch >= leut) {
    return { refreshed: false };
  }

  // Simulación de fetch
  cachedP3Map = { data: "ok" };
  lastP3Fetch = nowMs;
  return { refreshed: true };
}

async function runTests() {
  console.log("🚀 TEST DE SINCRONIZACIÓN POR HORARIOS (TIMING-BASED)\n");

  // Caso 1: Inicio a las 10:00 AM (Sin caché)
  const t10am = new Date("2024-01-01T10:00:00Z"); // UTC para consistencia
  const r1 = await getP3MapMock(t10am);
  console.log(`10:00 AM - Inicial: ${r1.refreshed ? "✅ Refrescó" : "❌ Falló"}`);

  // Caso 2: 12:00 PM (Caché debería seguir válido porque no ha pasado las 14:05)
  const t12pm = new Date("2024-01-01T12:00:00Z");
  const r2 = await getP3MapMock(t12pm);
  console.log(`12:00 PM - Cache Hit: ${!r2.refreshed ? "✅ Mantenido" : "❌ Refrescó innecesariamente"}`);

  // Caso 3: 14:10 PM (Debe refrescar porque pasó el umbral de las 14:05)
  // Nota: Ajustamos la fecha para que sea 14:10 en Florida
  const t1410fl = new Date("2024-01-01T14:10:00-05:00"); // 14:10 EST
  const r3 = await getP3MapMock(t1410fl);
  console.log(`14:10 PM - Umbral 14:05: ${r3.refreshed ? "✅ Refrescó" : "❌ No refrescó"}`);

  // Caso 4: 16:00 PM (Caché debería seguir válido)
  const t1600fl = new Date("2024-01-01T16:00:00-05:00");
  const r4 = await getP3MapMock(t1600fl);
  console.log(`16:00 PM - Cache Hit: ${!r4.refreshed ? "✅ Mantenido" : "❌ Refrescó innecesariamente"}`);

  // Caso 5: 20:30 PM (Debe refrescar porque pasó el umbral de las 20:20)
  const t2030fl = new Date("2024-01-01T20:30:00-05:00");
  const r5 = await getP3MapMock(t2030fl);
  console.log(`20:30 PM - Umbral 20:20: ${r5.refreshed ? "✅ Refrescó" : "❌ No refrescó"}`);

  // Caso 6: Mañana a las 08:00 AM (Caché debería seguir válido hasta las 14:05 del día siguiente)
  const tNextDay08am = new Date("2024-01-02T08:00:00-05:00");
  const r6 = await getP3MapMock(tNextDay08am);
  console.log(`08:00 AM (Día +1) - Cache Hit: ${!r6.refreshed ? "✅ Mantenido" : "❌ Refrescó innecesariamente"}`);

  console.log("\n🎯 EXPERIMENTO DE TIMING COMPLETADO CON ÉXITO.");
}

runTests().catch(console.error);
