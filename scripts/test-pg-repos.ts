/**
 * Test de Integración — Todos los Postgres Repositories
 * Ejecutar: npx tsx scripts/test-pg-repos.ts
 *
 * Requiere DATABASE_URL en .env (External URL para local, Internal para Render).
 * Verifica CRUD de los 8 repos nuevos + repos existentes (Users, Draws).
 */

// Carga .env manualmente (sin dotenv — no está en deps del proyecto)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
try {
  const envPath = resolve(process.cwd(), ".env");
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
} catch { /* .env opcional */ }
import { getDbPool } from "../src/infrastructure/database/PostgresConnection.js";

// ── Repositorios nuevos ─────────────────────────────────────────────────────
import { loadStrategiesFromPG, saveStrategiesToPG } from "../src/infrastructure/database/PostgresStrategyRepository.js";
import { loadPlansFromPG, savePlansToPG } from "../src/infrastructure/database/PostgresPlanRepository.js";
import {
  loadAnnouncementsFromPG,
  addAnnouncementToPG,
  editAnnouncementInPG,
  deleteAnnouncementFromPG,
} from "../src/infrastructure/database/PostgresAnnouncementRepository.js";
import {
  loadSugerenciasFromPG,
  appendSugerenciaToPG,
  getSugerenciaForUserPG,
} from "../src/infrastructure/database/PostgresSugerenciaRepository.js";
import {
  loadPaymentMethodsFromPG,
  savePaymentMethodsToPG,
} from "../src/infrastructure/database/PostgresPaymentMethodRepository.js";
import {
  loadTestingCutoffDatePG,
  saveTestingCutoffDatePG,
} from "../src/infrastructure/database/PostgresTestingConfigRepository.js";
import {
  loadLeadsFromPG,
  saveLeadToPG,
} from "../src/infrastructure/database/PostgresLeadRepository.js";
import {
  loadStrategyRequestsFromPG,
  addStrategyRequestToPG,
  removeStrategyRequestFromPG,
} from "../src/infrastructure/database/PostgresStrategyRequestRepository.js";
// ── Repos existentes ────────────────────────────────────────────────────────
import { loadUsersFromPG } from "../src/infrastructure/database/PostgresUserSync.js";
import { loadDrawsFromDB } from "../src/infrastructure/database/PostgresDrawRepository.js";

// ── Helpers ─────────────────────────────────────────────────────────────────
const TEST_USER_ID = 999999999; // ID ficticio — solo para leads/strategy_requests (sin FK)
let REAL_USER_ID = 0;           // Se resuelve al inicio desde un usuario real en DB
let passed = 0;
let failed = 0;

function ok(label: string, value: boolean) {
  if (value) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}`);
    failed++;
  }
}

async function cleanTestData(pool: ReturnType<typeof getDbPool>) {
  await pool.query("DELETE FROM leads WHERE user_id=$1", [TEST_USER_ID]);
  await pool.query("DELETE FROM strategy_requests WHERE user_id=$1", [TEST_USER_ID]);
  if (REAL_USER_ID) await pool.query("DELETE FROM suggestions WHERE user_id=$1 AND text LIKE '%TEST_BLISS%'", [REAL_USER_ID]);
  await pool.query("DELETE FROM testing_config WHERE key=$1", [`cutoff_${TEST_USER_ID}`]);
  await pool.query("DELETE FROM announcements WHERE text LIKE '%TEST_BLISS%'");
  await pool.query("DELETE FROM payment_methods WHERE name LIKE 'pm_test_%'");
}

// ── Tests ────────────────────────────────────────────────────────────────────

async function testConnection() {
  console.log("\n🔌 [1] Conexión a PostgreSQL");
  const pool = getDbPool();
  const { rows } = await pool.query("SELECT NOW() as ts, current_database() as db");
  ok("Pool conecta y responde", rows.length === 1);
  ok("Base de datos es ballbot_db", rows[0].db === "ballbot_db");
  console.log(`     → timestamp: ${rows[0].ts} | db: ${rows[0].db}`);
}

async function testExistingRepos() {
  console.log("\n👥 [2] Repos existentes — Users + Draws");
  const users = await loadUsersFromPG();
  ok("loadUsersFromPG retorna array", Array.isArray(users.allowed));
  ok("Hay usuarios aprobados en producción", users.allowed.length > 0);
  console.log(`     → ${users.allowed.length} usuarios aprobados, ${Object.keys(users.requestedPlans).length} pendientes`);

  const p3map = await loadDrawsFromDB("p3");
  ok("loadDrawsFromDB(p3) retorna mapa", typeof p3map === "object");
  const p3Count = Object.keys(p3map).length;
  ok("Hay sorteos P3 en DB", p3Count > 0);
  console.log(`     → ${p3Count} fechas P3 en DB`);
}

async function testStrategies() {
  console.log("\n🎯 [3] PostgresStrategyRepository");
  const original = await loadStrategiesFromPG();
  ok("loadStrategiesFromPG retorna array", Array.isArray(original));
  ok("Hay estrategias en DB", original.length > 0);
  console.log(`     → ${original.length} estrategias en DB`);

  // Verifica que save es idempotente (no destruye datos)
  await saveStrategiesToPG(original);
  const after = await loadStrategiesFromPG();
  ok("saveStrategiesToPG es idempotente (mismo count)", after.length === original.length);
  ok("IDs preservados tras save", after[0]?.id === original[0]?.id);
}

async function testPlans() {
  console.log("\n📋 [4] PostgresPlanRepository");
  const plans = await loadPlansFromPG();
  ok("loadPlansFromPG retorna array", Array.isArray(plans));
  ok("Hay planes en DB", plans.length > 0);
  console.log(`     → ${plans.length} planes: ${plans.map((p) => p.id).join(", ")}`);

  await savePlansToPG(plans);
  const after = await loadPlansFromPG();
  ok("savePlansToPG es idempotente", after.length === plans.length);
}

async function testAnnouncements() {
  console.log("\n📢 [5] PostgresAnnouncementRepository");
  const initial = await loadAnnouncementsFromPG();
  console.log(`     → ${initial.length} anuncios previos`);

  // ADD
  const after = await addAnnouncementToPG("TEST_BLISS mensaje de prueba", "26/03/2026 12:00");
  ok("addAnnouncementToPG agrega 1", after.length === initial.length + 1);
  const added = after.find((a) => a.texto === "TEST_BLISS mensaje de prueba");
  ok("El anuncio tiene id (timestamp string)", !!added?.id && added.id.length > 0);

  // EDIT
  if (added) {
    const edited = await editAnnouncementInPG(added.id, "TEST_BLISS editado");
    ok("editAnnouncementInPG retorna lista", Array.isArray(edited));
    ok("Texto editado correctamente", edited?.some((a) => a.texto === "TEST_BLISS editado") ?? false);

    // DELETE
    const deleted = await deleteAnnouncementFromPG(added.id);
    ok("deleteAnnouncementFromPG retorna lista", Array.isArray(deleted));
    ok("Vuelve al count original", deleted?.length === initial.length);
  }
}

async function testSugerencias() {
  console.log("\n💬 [6] PostgresSugerenciaRepository");
  const pool = getDbPool();

  if (!REAL_USER_ID) {
    console.log("     ⚠️  Sin usuario real disponible — skipping");
    return;
  }
  // Limpia datos de test anteriores
  await pool.query("DELETE FROM suggestions WHERE user_id=$1 AND text LIKE '%TEST_BLISS%'", [REAL_USER_ID]);

  await appendSugerenciaToPG({
    userId: REAL_USER_ID,
    nombre: "Test BLISS",
    telefono: "555-0000",
    texto: "Sugerencia de prueba TEST_BLISS",
    fecha: "26/03/2026 12:00",
  });
  ok("appendSugerenciaToPG no lanza error", true);

  const forUser = await getSugerenciaForUserPG(REAL_USER_ID);
  const testSug = forUser.find((s) => s.texto === "Sugerencia de prueba TEST_BLISS");
  ok("getSugerenciaForUserPG encuentra la sugerencia de test", !!testSug);
  ok("nombre correcto", testSug?.nombre === "Test BLISS");

  const all = await loadSugerenciasFromPG();
  ok("loadSugerenciasFromPG incluye la sugerencia de test", all.some((s) => s.texto === "Sugerencia de prueba TEST_BLISS"));

  await pool.query("DELETE FROM suggestions WHERE user_id=$1 AND text LIKE '%TEST_BLISS%'", [REAL_USER_ID]);
}

async function testPaymentMethods() {
  console.log("\n💳 [7] PostgresPaymentMethodRepository");
  const pool = getDbPool();
  await pool.query("DELETE FROM payment_methods WHERE name LIKE 'pm_test_%'");

  const testPMs = [
    { id: `pm_test_${Date.now()}`, description: "Zelle BLISS", account: "test@bliss.com", currency: "USD" },
    { id: `pm_test_${Date.now() + 1}`, description: "CashApp BLISS", account: "$blisstest", currency: "USD" },
  ];

  await savePaymentMethodsToPG(testPMs);
  const loaded = await loadPaymentMethodsFromPG();
  const testLoaded = loaded.filter((p) => p.id.startsWith("pm_test_"));
  ok("savePaymentMethodsToPG guarda 2 métodos de pago", testLoaded.length === 2);
  ok("description preservada", testLoaded.some((p) => p.description === "Zelle BLISS"));
  ok("account preservada", testLoaded.some((p) => p.account === "test@bliss.com"));
  ok("currency preservada", testLoaded.every((p) => p.currency === "USD"));

  // Restore: guarda vacío para que no queden datos de test
  await pool.query("DELETE FROM payment_methods WHERE name LIKE 'pm_test_%'");
  ok("Cleanup payment_methods completado", true);
}

async function testTestingConfig() {
  console.log("\n🧪 [8] PostgresTestingConfigRepository");
  const pool = getDbPool();
  await pool.query("DELETE FROM testing_config WHERE key=$1", [`cutoff_${TEST_USER_ID}`]);

  // Sin registro → null
  const none = await loadTestingCutoffDatePG(TEST_USER_ID);
  ok("loadTestingCutoffDatePG retorna null si no existe", none === null);

  // Guardar fecha
  await saveTestingCutoffDatePG("03/20/26", TEST_USER_ID);
  const loaded = await loadTestingCutoffDatePG(TEST_USER_ID);
  ok("saveTestingCutoffDatePG guarda fecha MM/DD/YY", loaded === "03/20/26");

  // Eliminar (null)
  await saveTestingCutoffDatePG(null, TEST_USER_ID);
  const deleted = await loadTestingCutoffDatePG(TEST_USER_ID);
  ok("saveTestingCutoffDatePG(null) elimina la entrada", deleted === null);
}

async function testLeads() {
  console.log("\n📊 [9] PostgresLeadRepository");
  const pool = getDbPool();
  await pool.query("DELETE FROM leads WHERE user_id=$1", [TEST_USER_ID]);

  await saveLeadToPG(TEST_USER_ID, "Test Lead BLISS", "555-9999", "Pro", "1m", "trial_active");
  const leads = await loadLeadsFromPG();
  const testLead = leads.find((l) => l.userId === String(TEST_USER_ID));
  ok("saveLeadToPG guarda lead", !!testLead);
  ok("nombre correcto", testLead?.nombre === "Test Lead BLISS");
  ok("plan correcto", testLead?.plan === "Pro");
  ok("status correcto", testLead?.status === "trial_active");

  // UPSERT — actualizar status
  await saveLeadToPG(TEST_USER_ID, "Test Lead BLISS", "555-9999", "Pro", "1m", "converted");
  const updated = (await loadLeadsFromPG()).find((l) => l.userId === String(TEST_USER_ID));
  ok("UPSERT actualiza status a 'converted'", updated?.status === "converted");

  await pool.query("DELETE FROM leads WHERE user_id=$1", [TEST_USER_ID]);
}

async function testStrategyRequests() {
  console.log("\n📝 [10] PostgresStrategyRequestRepository");
  const pool = getDbPool();
  await pool.query("DELETE FROM strategy_requests WHERE user_id=$1", [TEST_USER_ID]);

  // ADD
  const added = await addStrategyRequestToPG(TEST_USER_ID, "freq_analysis");
  ok("addStrategyRequestToPG retorna true en primera inserción", added === true);

  // Duplicate → false
  const dup = await addStrategyRequestToPG(TEST_USER_ID, "freq_analysis");
  ok("addStrategyRequestToPG retorna false en duplicado", dup === false);

  const list = await loadStrategyRequestsFromPG();
  const testReq = list.find((r) => r.userId === TEST_USER_ID && r.menuId === "freq_analysis");
  ok("loadStrategyRequestsFromPG contiene la solicitud", !!testReq);
  ok("requestedAt es un número válido", typeof testReq?.requestedAt === "number" && testReq.requestedAt > 0);

  // REMOVE
  const removed = await removeStrategyRequestFromPG(TEST_USER_ID, "freq_analysis");
  ok("removeStrategyRequestFromPG retorna true", removed === true);

  const listAfter = await loadStrategyRequestsFromPG();
  ok("Solicitud eliminada de la lista", !listAfter.some((r) => r.userId === TEST_USER_ID));

  await pool.query("DELETE FROM strategy_requests WHERE user_id=$1", [TEST_USER_ID]);
}

async function testGuardActive() {
  console.log("\n🔒 [11] Guards DATABASE_URL-first activos en user-config.ts");
  ok("process.env.DATABASE_URL está definido", !!process.env.DATABASE_URL);
  ok("DATABASE_URL no es la interna (local usa externa)",
    process.env.DATABASE_URL?.includes("oregon-postgres.render.com") ?? false);
  console.log(`     → DATABASE_SSL=${process.env.DATABASE_SSL}`);
  console.log(`     → Para Render Web Service usar: postgresql://ballbot:***@dpg-d70k07ruibrs73cj5300-a/ballbot_db + DATABASE_SSL=false`);
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║   BALLBOT — Test de Integración Postgres Repositories    ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (!process.env.DATABASE_URL) {
    console.error("\n❌ DATABASE_URL no definido. Corre: source .env antes del script.");
    process.exit(1);
  }

  const pool = getDbPool();

  // Resuelve un userId real con FK válida para tests que lo requieren (suggestions)
  const { rows: realUsers } = await pool.query("SELECT id FROM users WHERE plan_status='approved' LIMIT 1");
  if (realUsers.length > 0) {
    REAL_USER_ID = Number(realUsers[0].id);
    console.log(`\n     → REAL_USER_ID para FK tests: ${REAL_USER_ID}`);
  }

  await cleanTestData(pool);

  try {
    await testConnection();
    await testExistingRepos();
    await testStrategies();
    await testPlans();
    await testAnnouncements();
    await testSugerencias();
    await testPaymentMethods();
    await testTestingConfig();
    await testLeads();
    await testStrategyRequests();
    await testGuardActive();
  } finally {
    await cleanTestData(pool);
    await pool.end();
  }

  console.log("\n══════════════════════════════════════════════════════════");
  console.log(`  Resultado: ${passed} ✅ passed  |  ${failed} ❌ failed`);
  console.log("══════════════════════════════════════════════════════════");

  if (failed > 0) {
    console.error("\n⛔ HAY FALLOS — NO hacer commit hasta resolver.\n");
    process.exit(1);
  } else {
    console.log("\n🚀 TODOS LOS TESTS PASARON — Safe to commit & deploy.\n");
  }
}

main().catch((e) => {
  console.error("UNCAUGHT ERROR:", e);
  process.exit(1);
});
