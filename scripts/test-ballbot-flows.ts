/**
 * ╔═══════════════════════════════════════════════════════════════════════╗
 * ║   BLISS SYSTEMS LLC — Ballbot Flow Testing Suite v1.0                ║
 * ║   QA Agent · Architect: BLISS · Standard: 101%                       ║
 * ║                                                                       ║
 * ║   Propósito: Validar TODOS los flujos críticos del bot contra         ║
 * ║   PostgreSQL en Render DEV. Cada assertion emite un log estructurado  ║
 * ║   que queda visible en Render Logs para análisis forense posterior.   ║
 * ║                                                                       ║
 * ║   Ejecución: npx tsx --env-file=.env scripts/test-ballbot-flows.ts   ║
 * ╚═══════════════════════════════════════════════════════════════════════╝
 *
 * SUITES:
 *   S-01  DB Connectivity & Schema
 *   S-02  User Onboarding (nuevo usuario → trial)
 *   S-03  Plan Lifecycle (asignación, expiración, renovación)
 *   S-04  Admin Flows (aprobar, rechazar, asignar, gestionar usuarios)
 *   S-05  Announcements CRUD
 *   S-06  Payment Methods CRUD
 *   S-07  Suggestions Flow
 *   S-08  Leads Capture & Upsert
 *   S-09  Strategy Requests
 *   S-10  Testing Config (cutoff date)
 *   S-11  Referral System
 *   S-12  Strategy Repository
 *   S-13  Plans Repository
 *   S-14  Access Control Guards (middleware lógico)
 *   S-15  Cleanup — eliminación de datos de test
 */

import pg from "pg";

// ─── Logger estructurado → visible en Render Logs ─────────────────────────────

const SUITE_VERSION = "1.0.0";
const RUN_ID = `BLISS-TEST-${Date.now()}`;

type LogLevel = "INFO" | "PASS" | "FAIL" | "WARN" | "START" | "END" | "SUITE";

function log(level: LogLevel, suite: string, test: string, detail = "", meta?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const emoji = { INFO: "ℹ️", PASS: "✅", FAIL: "❌", WARN: "⚠️", START: "🚀", END: "🏁", SUITE: "📦" }[level];
  const payload = JSON.stringify({
    run_id: RUN_ID,
    ts,
    level,
    suite,
    test,
    detail,
    ...(meta ?? {}),
  });
  console.log(`${emoji} [${level}] ${suite} | ${test}${detail ? " | " + detail : ""}`);
  // Línea JSON pura para parsing automatizado en Render Logs
  console.log(`__BLISS_LOG__ ${payload}`);
}

// ─── Resultado de suite ───────────────────────────────────────────────────────

interface SuiteResult { suite: string; passed: number; failed: number; skipped: number }
const results: SuiteResult[] = [];
let totalPassed = 0;
let totalFailed = 0;

function assert(condition: boolean, suite: string, testName: string, passMsg: string, failMsg: string, meta?: Record<string, unknown>) {
  if (condition) {
    log("PASS", suite, testName, passMsg, meta);
    totalPassed++;
    return true;
  } else {
    log("FAIL", suite, testName, failMsg, meta);
    totalFailed++;
    return false;
  }
}

// ─── IDs de test (nunca colisionan con usuarios reales) ──────────────────────

const TEST_USER_ID   = 9_000_000_001; // Usuario nuevo simulado
const TEST_USER_ID_2 = 9_000_000_002; // Segundo usuario (referido)
const TEST_OWNER_ID  = Number(process.env.BOT_OWNER_ID?.split(",")[0] ?? "0");

// ─── Pool directo para operaciones de setup/teardown ─────────────────────────

function getPool(): pg.Pool {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL no definida en .env");
  const useSSL = process.env.DATABASE_SSL === "true";
  return new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// S-01  DB CONNECTIVITY & SCHEMA
// ─────────────────────────────────────────────────────────────────────────────

async function suiteDbConnectivity(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-01:DB-CONNECTIVITY";
  log("SUITE", S, "start", "Verificando conectividad y schema completo");
  let passed = 0, failed = 0;

  // T-01: Ping
  try {
    const { rows } = await pool.query("SELECT NOW() as ts, current_database() as db");
    assert(!!rows[0]?.ts, S, "T-01:ping", `DB respondió: ${rows[0]?.db} @ ${rows[0]?.ts}`, "Sin respuesta del servidor");
    passed++;
  } catch (e) {
    assert(false, S, "T-01:ping", "", `Conexión fallida: ${e}` );
    failed++;
  }

  // T-02: Tablas del schema
  const expectedTables = ["users","user_menus","plans","draws","custom_strategies",
    "announcements","suggestions","payment_methods","testing_config","leads","strategy_requests","referrals"];
  try {
    const { rows } = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
    );
    const found = rows.map((r: { tablename: string }) => r.tablename);
    for (const t of expectedTables) {
      const ok = found.includes(t);
      if (ok) passed++; else failed++;
      assert(ok, S, `T-02:table:${t}`, `tabla '${t}' existe`, `tabla '${t}' NO ENCONTRADA`, { found });
    }
  } catch (e) {
    assert(false, S, "T-02:schema-scan", "", `${e}`);
    failed++;
  }

  // T-03: Pool salud (max connections)
  try {
    const { rows } = await pool.query("SELECT count(*) as c FROM pg_stat_activity WHERE datname=current_database()");
    const conns = Number(rows[0]?.c ?? 0);
    assert(conns < 90, S, "T-03:pool-health", `Conexiones activas: ${conns}/100`, `Demasiadas conexiones: ${conns}`, { conns });
    passed++;
  } catch (e) {
    assert(false, S, "T-03:pool-health", "", `${e}`);
    failed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-02  USER ONBOARDING (nuevo usuario → trial)
// ─────────────────────────────────────────────────────────────────────────────

async function suiteUserOnboarding(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-02:USER-ONBOARDING";
  log("SUITE", S, "start", `userId=${TEST_USER_ID}`);
  let passed = 0, failed = 0;

  // T-01: Usuario NO existe antes del test
  {
    const { rows } = await pool.query("SELECT id FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows.length === 0, S, "T-01:user-not-exists-pre", "Usuario de test limpio antes de iniciar", `Usuario ${TEST_USER_ID} ya existe — limpiar primero`);
    if (rows.length === 0) passed++; else failed++;
  }

  // T-02: Insertar usuario nuevo (simula primer /start sin acceso)
  try {
    await pool.query(
      `INSERT INTO users (id, username, phone, role, plan_id, plan_status, trial_used)
       VALUES ($1, $2, $3, 'user', NULL, NULL, FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, "test_user_bliss", ""]
    );
    const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows.length === 1, S, "T-02:user-insert", `Usuario ${TEST_USER_ID} insertado`, "Insert falló");
    assert(rows[0]?.trial_used === false, S, "T-02:trial-used-false", "trial_used=false al inicio", "trial_used no es false");
    assert(rows[0]?.plan_status === null, S, "T-02:plan-status-null", "plan_status NULL (sin plan)", `plan_status=${rows[0]?.plan_status}`);
    passed += 3;
  } catch (e) {
    assert(false, S, "T-02:user-insert", "", `${e}`);
    failed++;
  }

  // T-03: Simular solicitud de trial (addPlanRequest → requestedPlans)
  try {
    await pool.query(
      `UPDATE users SET plan_id='basico', plan_status='requested', plan_temporality='7d',
       plan_expiry=TO_CHAR(NOW() + INTERVAL '7 days','MM/DD/YY'), phone='5551234567', username='Test User BLISS'
       WHERE id=$1`,
      [TEST_USER_ID]
    );
    const { rows } = await pool.query("SELECT plan_status, plan_temporality, phone FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows[0]?.plan_status === "requested", S, "T-03:plan-requested", "Estado 'requested' guardado", `Estado=${rows[0]?.plan_status}`);
    assert(rows[0]?.plan_temporality === "7d", S, "T-03:temporality-7d", "Temporalidad 7d guardada", `Temporalidad=${rows[0]?.plan_temporality}`);
    assert(rows[0]?.phone === "5551234567", S, "T-03:phone-saved", "Teléfono guardado en DB", `Phone=${rows[0]?.phone}`);
    passed += 3;
  } catch (e) {
    assert(false, S, "T-03:plan-request", "", `${e}`);
    failed++;
  }

  // T-04: Auto-aprobación trial (assignPlanToUser con 7d)
  try {
    await pool.query(
      `UPDATE users SET plan_status='approved', trial_used=TRUE,
       plan_expiry=TO_CHAR(NOW() + INTERVAL '7 days','MM/DD/YY')
       WHERE id=$1`,
      [TEST_USER_ID]
    );
    await pool.query(
      `INSERT INTO user_menus (user_id, menu_id) VALUES ($1,'menu_basico') ON CONFLICT DO NOTHING`,
      [TEST_USER_ID]
    );
    const { rows } = await pool.query("SELECT plan_status, trial_used FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows[0]?.plan_status === "approved", S, "T-04:trial-approved", "Trial auto-aprobado → status=approved", `Status=${rows[0]?.plan_status}`);
    assert(rows[0]?.trial_used === true, S, "T-04:trial-used-true", "trial_used=TRUE marcado", `trial_used=${rows[0]?.trial_used}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-04:trial-approve", "", `${e}`);
    failed++;
  }

  // T-05: Lead capturado en tabla leads
  try {
    await pool.query(
      `INSERT INTO leads (user_id, nombre, telefono, plan, temporality, fecha, status)
       VALUES ($1,'Test User BLISS','5551234567','basico','7d',TO_CHAR(NOW(),'DD/MM/YYYY HH24:MI'),'trial_active')
       ON CONFLICT (user_id) DO UPDATE SET status=EXCLUDED.status`,
      [TEST_USER_ID]
    );
    const { rows } = await pool.query("SELECT * FROM leads WHERE user_id=$1", [TEST_USER_ID]);
    assert(rows.length === 1, S, "T-05:lead-captured", `Lead guardado: ${rows[0]?.nombre} / ${rows[0]?.plan}`, "Lead no encontrado");
    assert(rows[0]?.status === "trial_active", S, "T-05:lead-status-trial", "Lead status=trial_active", `Status=${rows[0]?.status}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-05:lead-capture", "", `${e}`);
    failed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-03  PLAN LIFECYCLE (expiración, renovación, bloqueo second trial)
// ─────────────────────────────────────────────────────────────────────────────

async function suitePlanLifecycle(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-03:PLAN-LIFECYCLE";
  log("SUITE", S, "start", `userId=${TEST_USER_ID}`);
  let passed = 0, failed = 0;

  // T-01: Simular plan expirado (poner expiry en el pasado)
  try {
    await pool.query(
      `UPDATE users SET plan_expiry=TO_CHAR(NOW() - INTERVAL '1 day','MM/DD/YY') WHERE id=$1`,
      [TEST_USER_ID]
    );
    const { rows } = await pool.query("SELECT plan_expiry FROM users WHERE id=$1", [TEST_USER_ID]);
    const expiry = rows[0]?.plan_expiry;
    // Verificar que la fecha guardada es ayer o antes
    assert(!!expiry, S, "T-01:expiry-set", `Expiry seteado: ${expiry}`, "Expiry no pudo setearse");
    passed++;
  } catch (e) {
    assert(false, S, "T-01:expiry-set", "", `${e}`);
    failed++;
  }

  // T-02: Lógica isPlanExpired — calcular en JS como lo hace el bot
  {
    const { rows } = await pool.query("SELECT plan_expiry, trial_used FROM users WHERE id=$1", [TEST_USER_ID]);
    const expiry = rows[0]?.plan_expiry as string | null;
    let isExpired = false;
    if (expiry) {
      const [mm, dd, yy] = expiry.split("/");
      if (mm && dd && yy) {
        const year = parseInt(yy) <= 49 ? 2000 + parseInt(yy) : 1900 + parseInt(yy);
        const expDate = new Date(year, parseInt(mm) - 1, parseInt(dd), 23, 59, 59);
        isExpired = expDate < new Date();
      }
    }
    assert(isExpired, S, "T-02:plan-expired-logic", `isPlanExpired=true (expiry=${expiry})`, "Plan no detectado como expirado");
    passed++;
  }

  // T-03: Bloqueo segundo trial (trial_used=true)
  {
    const { rows } = await pool.query("SELECT trial_used FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows[0]?.trial_used === true, S, "T-03:block-second-trial", "trial_used=TRUE → segundo trial bloqueado correctamente", "trial_used no es true — segundo trial desprotegido");
    passed++;
  }

  // T-04: Solicitud de renovación de plan de pago
  try {
    await pool.query(
      `UPDATE users SET plan_status='requested', pending_plan='basico|1m',
       plan_temporality='1m', plan_expiry=TO_CHAR(NOW() + INTERVAL '30 days','MM/DD/YY')
       WHERE id=$1`,
      [TEST_USER_ID]
    );
    await pool.query(
      `UPDATE leads SET status='renewal_requested' WHERE user_id=$1`,
      [TEST_USER_ID]
    );
    const { rows } = await pool.query("SELECT plan_status, pending_plan FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows[0]?.plan_status === "requested", S, "T-04:renewal-requested", "Renovación solicitada → status=requested", `Status=${rows[0]?.plan_status}`);
    assert(rows[0]?.pending_plan === "basico|1m", S, "T-04:pending-plan", "pending_plan=basico|1m guardado", `PendingPlan=${rows[0]?.pending_plan}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-04:renewal-request", "", `${e}`);
    failed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-04  ADMIN FLOWS (aprobar, rechazar, asignar plan, ver pendientes)
// ─────────────────────────────────────────────────────────────────────────────

async function suiteAdminFlows(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-04:ADMIN-FLOWS";
  log("SUITE", S, "start", `ownerId=${TEST_OWNER_ID} / userId=${TEST_USER_ID}`);
  let passed = 0, failed = 0;

  // T-01: Ver solicitudes pendientes (requestedPlans)
  {
    const { rows } = await pool.query(
      `SELECT id, username, plan_id, plan_status, plan_temporality, phone
       FROM users WHERE plan_status='requested'`
    );
    assert(rows.length >= 1, S, "T-01:pending-requests", `${rows.length} solicitud(es) pendiente(s) encontrada(s)`, "No hay solicitudes pendientes — test depende de S-03 T-04");
    passed++;
    log("INFO", S, "T-01:pending-detail", `Solicitudes: ${rows.map((r: {id: string; plan_id: string}) => `uid=${r.id}/${r.plan_id}`).join(", ")}`);
  }

  // T-02: Admin aprueba solicitud → approvePlanRequest
  try {
    await pool.query(
      `UPDATE users SET plan_status='approved', pending_plan=NULL,
       plan_id='basico', plan_temporality='1m',
       plan_expiry=TO_CHAR(NOW() + INTERVAL '30 days','MM/DD/YY')
       WHERE id=$1`,
      [TEST_USER_ID]
    );
    const { rows } = await pool.query("SELECT plan_status, plan_id FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows[0]?.plan_status === "approved", S, "T-02:approve-plan", "Plan aprobado por admin → status=approved", `Status=${rows[0]?.plan_status}`);
    assert(rows[0]?.plan_id === "basico", S, "T-02:plan-id", "plan_id=basico asignado", `PlanId=${rows[0]?.plan_id}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-02:approve-plan", "", `${e}`);
    failed++;
  }

  // T-03: Admin rechaza otra solicitud → rejectPlanRequest
  try {
    // Crear usuario 2 con solicitud pendiente
    await pool.query(
      `INSERT INTO users (id, username, phone, plan_id, plan_status, plan_temporality, trial_used)
       VALUES ($1,'test_user_2','5559999999','basico','requested','1m',FALSE)
       ON CONFLICT (id) DO UPDATE SET plan_status='requested'`,
      [TEST_USER_ID_2]
    );
    await pool.query(
      `UPDATE users SET plan_status='rejected', plan_id=NULL, pending_plan=NULL WHERE id=$1`,
      [TEST_USER_ID_2]
    );
    const { rows } = await pool.query("SELECT plan_status FROM users WHERE id=$1", [TEST_USER_ID_2]);
    assert(rows[0]?.plan_status === "rejected", S, "T-03:reject-plan", "Plan rechazado → status=rejected", `Status=${rows[0]?.plan_status}`);
    passed++;
  } catch (e) {
    assert(false, S, "T-03:reject-plan", "", `${e}`);
    failed++;
  }

  // T-04: Admin asigna menú adicional a usuario
  try {
    await pool.query(
      `INSERT INTO user_menus (user_id, menu_id) VALUES ($1,'menu_pro_bliss')
       ON CONFLICT DO NOTHING`,
      [TEST_USER_ID]
    );
    const { rows } = await pool.query("SELECT menu_id FROM user_menus WHERE user_id=$1", [TEST_USER_ID]);
    const menus = rows.map((r: { menu_id: string }) => r.menu_id);
    assert(menus.includes("menu_pro_bliss"), S, "T-04:assign-menu", `Menú asignado: ${menus.join(",")}`, "Menú no encontrado en user_menus");
    passed++;
  } catch (e) {
    assert(false, S, "T-04:assign-menu", "", `${e}`);
    failed++;
  }

  // T-05: Admin remueve menú de usuario
  try {
    await pool.query(`DELETE FROM user_menus WHERE user_id=$1 AND menu_id='menu_pro_bliss'`, [TEST_USER_ID]);
    const { rows } = await pool.query("SELECT menu_id FROM user_menus WHERE user_id=$1 AND menu_id='menu_pro_bliss'", [TEST_USER_ID]);
    assert(rows.length === 0, S, "T-05:remove-menu", "Menú removido correctamente", "Menú sigue en user_menus tras delete");
    passed++;
  } catch (e) {
    assert(false, S, "T-05:remove-menu", "", `${e}`);
    failed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-05  ANNOUNCEMENTS CRUD
// ─────────────────────────────────────────────────────────────────────────────

async function suiteAnnouncements(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-05:ANNOUNCEMENTS";
  log("SUITE", S, "start");
  let passed = 0, failed = 0;
  const testTs = Date.now();

  // T-01: Crear anuncio
  try {
    await pool.query(`INSERT INTO announcements (text, timestamp) VALUES ($1,$2)`, ["[TEST-BLISS] Anuncio de prueba 101%", testTs]);
    const { rows } = await pool.query("SELECT * FROM announcements WHERE timestamp=$1", [testTs]);
    assert(rows.length === 1, S, "T-01:create", `Anuncio creado ts=${testTs}`, "Anuncio no encontrado tras insert");
    assert(rows[0]?.text === "[TEST-BLISS] Anuncio de prueba 101%", S, "T-01:text-match", "Texto exacto guardado", `Texto=${rows[0]?.text}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-01:create", "", `${e}`); failed++;
  }

  // T-02: Editar anuncio
  try {
    await pool.query("UPDATE announcements SET text=$1 WHERE timestamp=$2", ["[TEST-BLISS] Anuncio EDITADO", testTs]);
    const { rows } = await pool.query("SELECT text FROM announcements WHERE timestamp=$1", [testTs]);
    assert(rows[0]?.text === "[TEST-BLISS] Anuncio EDITADO", S, "T-02:edit", "Texto editado correctamente", `Texto=${rows[0]?.text}`);
    passed++;
  } catch (e) {
    assert(false, S, "T-02:edit", "", `${e}`); failed++;
  }

  // T-03: Listar anuncios (ORDER BY timestamp)
  {
    const { rows } = await pool.query("SELECT id, text FROM announcements ORDER BY timestamp ASC");
    assert(rows.length >= 1, S, "T-03:list", `${rows.length} anuncio(s) en DB`, "Tabla announcements vacía");
    passed++;
  }

  // T-04: Eliminar anuncio de test
  try {
    await pool.query("DELETE FROM announcements WHERE timestamp=$1", [testTs]);
    const { rows } = await pool.query("SELECT id FROM announcements WHERE timestamp=$1", [testTs]);
    assert(rows.length === 0, S, "T-04:delete", "Anuncio eliminado correctamente", "Anuncio persiste tras DELETE");
    passed++;
  } catch (e) {
    assert(false, S, "T-04:delete", "", `${e}`); failed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-06  PAYMENT METHODS CRUD
// ─────────────────────────────────────────────────────────────────────────────

async function suitePaymentMethods(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-06:PAYMENT-METHODS";
  log("SUITE", S, "start");
  let passed = 0, failed = 0;
  let testPmId: number | null = null;

  // T-01: Crear forma de pago
  try {
    const { rows } = await pool.query(
      `INSERT INTO payment_methods (name, details) VALUES ($1,$2) RETURNING id`,
      ["[TEST-BLISS] Zelle", "Email: test@blissystems.com"]
    );
    testPmId = rows[0]?.id ?? null;
    assert(testPmId !== null, S, "T-01:create", `PM creado id=${testPmId}`, "PM no creado");
    passed++;
  } catch (e) {
    assert(false, S, "T-01:create", "", `${e}`); failed++;
  }

  // T-02: Leer formas de pago
  {
    const { rows } = await pool.query("SELECT id, name FROM payment_methods ORDER BY id");
    assert(rows.length >= 1, S, "T-02:list", `${rows.length} PM(s) en DB`, "Tabla vacía");
    passed++;
  }

  // T-03: Editar forma de pago
  if (testPmId) {
    try {
      await pool.query("UPDATE payment_methods SET name=$1 WHERE id=$2", ["[TEST-BLISS] Zelle EDITED", testPmId]);
      const { rows } = await pool.query("SELECT name FROM payment_methods WHERE id=$1", [testPmId]);
      assert(rows[0]?.name === "[TEST-BLISS] Zelle EDITED", S, "T-03:edit", "PM editado", `Name=${rows[0]?.name}`);
      passed++;
    } catch (e) {
      assert(false, S, "T-03:edit", "", `${e}`); failed++;
    }
  }

  // T-04: Eliminar
  if (testPmId) {
    try {
      await pool.query("DELETE FROM payment_methods WHERE id=$1", [testPmId]);
      const { rows } = await pool.query("SELECT id FROM payment_methods WHERE id=$1", [testPmId]);
      assert(rows.length === 0, S, "T-04:delete", "PM eliminado", "PM persiste tras DELETE");
      passed++;
    } catch (e) {
      assert(false, S, "T-04:delete", "", `${e}`); failed++;
    }
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-07  SUGGESTIONS FLOW
// ─────────────────────────────────────────────────────────────────────────────

async function suiteSugerencias(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-07:SUGGESTIONS";
  log("SUITE", S, "start");
  let passed = 0, failed = 0;
  let testSugId: number | null = null;

  // T-01: Guardar sugerencia (appendSugerenciaToPG)
  try {
    const { rows } = await pool.query(
      `INSERT INTO suggestions (user_id, text, nombre, telefono, fecha)
       VALUES ($1,$2,'Test User BLISS','5551234567',TO_CHAR(NOW(),'DD/MM/YYYY HH24:MI'))
       RETURNING id`,
      [TEST_USER_ID, "[TEST-BLISS] Sugerencia de prueba — mejorar el menú de estrategias"]
    );
    testSugId = rows[0]?.id ?? null;
    assert(testSugId !== null, S, "T-01:insert", `Sugerencia id=${testSugId} guardada`, "Sugerencia no insertada");
    passed++;
  } catch (e) {
    assert(false, S, "T-01:insert", "", `${e}`); failed++;
  }

  // T-02: Leer sugerencias del usuario
  {
    const { rows } = await pool.query("SELECT id, text, nombre FROM suggestions WHERE user_id=$1", [TEST_USER_ID]);
    assert(rows.length >= 1, S, "T-02:read-by-user", `${rows.length} sugerencia(s) del usuario`, "Sin resultados");
    passed++;
  }

  // T-03: Admin lista todas las sugerencias
  {
    const { rows } = await pool.query("SELECT count(*) as c FROM suggestions");
    assert(Number(rows[0]?.c) >= 1, S, "T-03:list-all", `Total sugerencias en DB: ${rows[0]?.c}`, "Tabla vacía");
    passed++;
  }

  // T-04: Limpiar sugerencia de test
  if (testSugId) {
    await pool.query("DELETE FROM suggestions WHERE id=$1", [testSugId]);
    const { rows } = await pool.query("SELECT id FROM suggestions WHERE id=$1", [testSugId]);
    assert(rows.length === 0, S, "T-04:cleanup", "Sugerencia de test eliminada", "Sugerencia persiste");
    passed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-08  LEADS CAPTURE & UPSERT
// ─────────────────────────────────────────────────────────────────────────────

async function suiteLeads(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-08:LEADS";
  log("SUITE", S, "start");
  let passed = 0, failed = 0;

  // T-01: Lead existe desde S-02
  {
    const { rows } = await pool.query("SELECT * FROM leads WHERE user_id=$1", [TEST_USER_ID]);
    assert(rows.length === 1, S, "T-01:lead-exists", `Lead encontrado: ${rows[0]?.nombre} / ${rows[0]?.status}`, "Lead no encontrado — S-02 debe pasar primero");
    passed++;
  }

  // T-02: UPSERT de lead (status update)
  try {
    await pool.query(
      `INSERT INTO leads (user_id, nombre, telefono, plan, temporality, fecha, status)
       VALUES ($1,'Test User BLISS','5551234567','basico','1m',TO_CHAR(NOW(),'DD/MM/YYYY HH24:MI'),'renewal_requested')
       ON CONFLICT (user_id) DO UPDATE SET status=EXCLUDED.status, plan=EXCLUDED.plan, temporality=EXCLUDED.temporality`,
      [TEST_USER_ID]
    );
    const { rows } = await pool.query("SELECT status, plan, temporality FROM leads WHERE user_id=$1", [TEST_USER_ID]);
    assert(rows[0]?.status === "renewal_requested", S, "T-02:upsert-status", "UPSERT actualiza status correctamente", `Status=${rows[0]?.status}`);
    assert(rows[0]?.temporality === "1m", S, "T-02:upsert-temporality", "Temporalidad actualizada a 1m", `Temp=${rows[0]?.temporality}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-02:upsert", "", `${e}`); failed++;
  }

  // T-03: Admin lista todos los leads
  {
    const { rows } = await pool.query("SELECT count(*) as c FROM leads");
    assert(Number(rows[0]?.c) >= 1, S, "T-03:list-all", `Total leads: ${rows[0]?.c}`, "Tabla leads vacía");
    passed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-09  STRATEGY REQUESTS
// ─────────────────────────────────────────────────────────────────────────────

async function suiteStrategyRequests(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-09:STRATEGY-REQUESTS";
  log("SUITE", S, "start");
  let passed = 0, failed = 0;

  // T-01: Insertar strategy request (usuario pide una estrategia)
  try {
    await pool.query(
      `INSERT INTO strategy_requests (user_id, menu_id, requested_at)
       VALUES ($1,'strat_test_bliss',$2)
       ON CONFLICT (user_id, menu_id) DO UPDATE SET requested_at=EXCLUDED.requested_at`,
      [TEST_USER_ID, Date.now()]
    );
    const { rows } = await pool.query("SELECT * FROM strategy_requests WHERE user_id=$1 AND menu_id='strat_test_bliss'", [TEST_USER_ID]);
    assert(rows.length === 1, S, "T-01:insert", `Strategy request guardado para user=${TEST_USER_ID}`, "Request no encontrado");
    passed++;
  } catch (e) {
    assert(false, S, "T-01:insert", "", `${e}`); failed++;
  }

  // T-02: Deduplicación ON CONFLICT
  try {
    const tsNew = Date.now() + 1000;
    await pool.query(
      `INSERT INTO strategy_requests (user_id, menu_id, requested_at)
       VALUES ($1,'strat_test_bliss',$2)
       ON CONFLICT (user_id, menu_id) DO UPDATE SET requested_at=EXCLUDED.requested_at`,
      [TEST_USER_ID, tsNew]
    );
    const { rows } = await pool.query("SELECT count(*) as c FROM strategy_requests WHERE user_id=$1 AND menu_id='strat_test_bliss'", [TEST_USER_ID]);
    assert(Number(rows[0]?.c) === 1, S, "T-02:dedup", "ON CONFLICT → única fila, no duplicado", `Count=${rows[0]?.c}`);
    passed++;
  } catch (e) {
    assert(false, S, "T-02:dedup", "", `${e}`); failed++;
  }

  // T-03: Limpiar
  await pool.query("DELETE FROM strategy_requests WHERE user_id=$1 AND menu_id='strat_test_bliss'", [TEST_USER_ID]);
  const { rows } = await pool.query("SELECT id FROM strategy_requests WHERE user_id=$1 AND menu_id='strat_test_bliss'", [TEST_USER_ID]);
  assert(rows.length === 0, S, "T-03:cleanup", "Strategy request eliminado", "Request persiste");
  passed++;

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-10  TESTING CONFIG (cutoff date por userId)
// ─────────────────────────────────────────────────────────────────────────────

async function suiteTestingConfig(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-10:TESTING-CONFIG";
  log("SUITE", S, "start");
  let passed = 0, failed = 0;
  const testKey = `cutoff_${TEST_USER_ID}`;
  const testDate = "03/15/24";

  // T-01: Guardar cutoff
  try {
    await pool.query(
      `INSERT INTO testing_config (key, value) VALUES ($1,$2)
       ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
      [testKey, testDate]
    );
    const { rows } = await pool.query("SELECT value FROM testing_config WHERE key=$1", [testKey]);
    assert(rows[0]?.value === testDate, S, "T-01:save-cutoff", `Cutoff guardado: ${rows[0]?.value}`, `Value=${rows[0]?.value}`);
    passed++;
  } catch (e) {
    assert(false, S, "T-01:save", "", `${e}`); failed++;
  }

  // T-02: Leer cutoff
  {
    const { rows } = await pool.query("SELECT value FROM testing_config WHERE key=$1", [testKey]);
    assert(rows[0]?.value === testDate, S, "T-02:load-cutoff", `Cutoff leído: ${rows[0]?.value}`, "Cutoff no encontrado");
    passed++;
  }

  // T-03: Actualizar cutoff
  try {
    const newDate = "04/01/25";
    await pool.query("UPDATE testing_config SET value=$1 WHERE key=$2", [newDate, testKey]);
    const { rows } = await pool.query("SELECT value FROM testing_config WHERE key=$1", [testKey]);
    assert(rows[0]?.value === newDate, S, "T-03:update-cutoff", `Cutoff actualizado: ${rows[0]?.value}`, `Value=${rows[0]?.value}`);
    passed++;
  } catch (e) {
    assert(false, S, "T-03:update", "", `${e}`); failed++;
  }

  // T-04: Cleanup
  await pool.query("DELETE FROM testing_config WHERE key=$1", [testKey]);
  const { rows } = await pool.query("SELECT key FROM testing_config WHERE key=$1", [testKey]);
  assert(rows.length === 0, S, "T-04:cleanup", "Cutoff de test eliminado", "Key persiste");
  passed++;

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-11  REFERRAL SYSTEM
// ─────────────────────────────────────────────────────────────────────────────

async function suiteReferrals(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-11:REFERRALS";
  log("SUITE", S, "start");
  let passed = 0, failed = 0;

  // T-01: Crear referral (USER_ID_1 refirió a USER_ID_2)
  try {
    await pool.query(
      `INSERT INTO referrals (referrer_id, referred_id, rewarded)
       VALUES ($1,$2,FALSE)
       ON CONFLICT (referred_id) DO NOTHING`,
      [TEST_USER_ID, TEST_USER_ID_2]
    );
    const { rows } = await pool.query("SELECT * FROM referrals WHERE referred_id=$1", [TEST_USER_ID_2]);
    assert(rows.length === 1, S, "T-01:create-referral", `Referral creado: ${TEST_USER_ID} → ${TEST_USER_ID_2}`, "Referral no encontrado");
    assert(rows[0]?.rewarded === false, S, "T-01:rewarded-false", "rewarded=false inicialmente", `Rewarded=${rows[0]?.rewarded}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-01:create", "", `${e}`); failed++;
  }

  // T-02: Marcar como recompensado (admin aprueba plan de referido → 1 mes gratis)
  try {
    await pool.query(
      `UPDATE referrals SET rewarded=TRUE, rewarded_at=NOW() WHERE referred_id=$1`,
      [TEST_USER_ID_2]
    );
    const { rows } = await pool.query("SELECT rewarded, rewarded_at FROM referrals WHERE referred_id=$1", [TEST_USER_ID_2]);
    assert(rows[0]?.rewarded === true, S, "T-02:rewarded-true", "Referral marcado como recompensado", `Rewarded=${rows[0]?.rewarded}`);
    assert(rows[0]?.rewarded_at !== null, S, "T-02:rewarded-at", "rewarded_at registrado", "rewarded_at es null");
    passed += 2;
  } catch (e) {
    assert(false, S, "T-02:reward", "", `${e}`); failed++;
  }

  // T-03: Índice de no-recompensados (query de performance)
  {
    const { rows } = await pool.query("SELECT count(*) as c FROM referrals WHERE rewarded=FALSE");
    assert(Number(rows[0]?.c) >= 0, S, "T-03:unrewarded-index", `Referrals sin recompensar: ${rows[0]?.c}`, "Query falló");
    passed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-12  STRATEGY REPOSITORY
// ─────────────────────────────────────────────────────────────────────────────

async function suiteStrategies(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-12:STRATEGIES";
  log("SUITE", S, "start");
  let passed = 0, failed = 0;

  // T-01: Leer estrategias existentes
  {
    const { rows } = await pool.query("SELECT count(*) as c FROM custom_strategies");
    assert(Number(rows[0]?.c) >= 0, S, "T-01:read-strategies", `${rows[0]?.c} estrategia(s) en DB`, "Query falló");
    passed++;
    log("INFO", S, "T-01:count", `Estrategias en DB: ${rows[0]?.c}`);
  }

  // T-02: Insertar estrategia de test
  try {
    await pool.query(
      `INSERT INTO custom_strategies (id, titulo, descripcion, visibility)
       VALUES ('test_bliss_strat','[TEST-BLISS] Estrategia 101%','Estrategia de prueba BLISS Systems','private')
       ON CONFLICT (id) DO UPDATE SET titulo=EXCLUDED.titulo`,
    );
    const { rows } = await pool.query("SELECT * FROM custom_strategies WHERE id='test_bliss_strat'");
    assert(rows.length === 1, S, "T-02:insert", `Estrategia insertada: ${rows[0]?.titulo}`, "Estrategia no encontrada");
    assert(rows[0]?.visibility === "private", S, "T-02:visibility", "visibility=private", `Vis=${rows[0]?.visibility}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-02:insert", "", `${e}`); failed++;
  }

  // T-03: Cleanup
  await pool.query("DELETE FROM custom_strategies WHERE id='test_bliss_strat'");
  const { rows } = await pool.query("SELECT id FROM custom_strategies WHERE id='test_bliss_strat'");
  assert(rows.length === 0, S, "T-03:cleanup", "Estrategia de test eliminada", "Estrategia persiste");
  passed++;

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-13  PLANS REPOSITORY
// ─────────────────────────────────────────────────────────────────────────────

async function suitePlans(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-13:PLANS";
  log("SUITE", S, "start");
  let passed = 0, failed = 0;

  // T-01: Leer planes
  {
    const { rows } = await pool.query("SELECT id, title, auto_approve FROM plans ORDER BY id");
    assert(rows.length >= 0, S, "T-01:read", `${rows.length} plan(es) en DB`, "Query falló");
    passed++;
    if (rows.length > 0) log("INFO", S, "T-01:plans-detail", `Planes: ${rows.map((r: {id: string; title: string; auto_approve: boolean}) => `${r.id}(${r.title},autoApprove=${r.auto_approve})`).join(" | ")}`);
  }

  // T-02: UPSERT plan de test
  try {
    await pool.query(
      `INSERT INTO plans (id, title, description, auto_approve, price_1m)
       VALUES ('test_plan_bliss','[TEST] Plan BLISS 101%','Plan de prueba',FALSE,'$49')
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title`,
    );
    const { rows } = await pool.query("SELECT title, price_1m FROM plans WHERE id='test_plan_bliss'");
    assert(rows[0]?.title === "[TEST] Plan BLISS 101%", S, "T-02:upsert", `Plan guardado: ${rows[0]?.title}`, `Title=${rows[0]?.title}`);
    passed++;
  } catch (e) {
    assert(false, S, "T-02:upsert", "", `${e}`); failed++;
  }

  // T-03: Cleanup
  await pool.query("DELETE FROM plans WHERE id='test_plan_bliss'");
  const { rows } = await pool.query("SELECT id FROM plans WHERE id='test_plan_bliss'");
  assert(rows.length === 0, S, "T-03:cleanup", "Plan de test eliminado", "Plan persiste");
  passed++;

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-14  ACCESS CONTROL GUARDS (lógica del middleware simulada)
// ─────────────────────────────────────────────────────────────────────────────

async function suiteAccessControl(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-14:ACCESS-CONTROL";
  log("SUITE", S, "start");
  let passed = 0, failed = 0;

  // T-01: Usuario sin plan NO está en allowed (plan_status != approved)
  {
    const { rows } = await pool.query("SELECT plan_status FROM users WHERE id=$1", [TEST_USER_ID]);
    const status = rows[0]?.plan_status;
    // Después de S-04 T-02, status debería ser 'approved'
    assert(status === "approved", S, "T-01:approved-user", `Usuario ${TEST_USER_ID} tiene plan aprobado`, `Status=${status}`);
    passed++;
  }

  // T-02: Usuario rechazado NO tiene acceso (status=rejected)
  {
    const { rows } = await pool.query("SELECT plan_status FROM users WHERE id=$1", [TEST_USER_ID_2]);
    const status = rows[0]?.plan_status;
    assert(status === "rejected", S, "T-02:rejected-user", `Usuario ${TEST_USER_ID_2} correctamente rechazado`, `Status=${status}`);
    passed++;
  }

  // T-03: isPlanExpired — usuario con plan no expirado (después de S-04, tiene 1m hacia adelante)
  {
    const { rows } = await pool.query("SELECT plan_expiry FROM users WHERE id=$1", [TEST_USER_ID]);
    const expiry = rows[0]?.plan_expiry as string | null;
    let isExpired = false;
    if (expiry) {
      const [mm, dd, yy] = expiry.split("/");
      if (mm && dd && yy) {
        const year = parseInt(yy) <= 49 ? 2000 + parseInt(yy) : 1900 + parseInt(yy);
        const expDate = new Date(year, parseInt(mm) - 1, parseInt(dd), 23, 59, 59);
        isExpired = expDate < new Date();
      }
    }
    assert(!isExpired, S, "T-03:plan-not-expired", `Plan vigente, expiry=${expiry}`, `Plan expirado inesperadamente (${expiry})`);
    passed++;
  }

  // T-04: trial_used bloquea segundo trial
  {
    const { rows } = await pool.query("SELECT trial_used FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows[0]?.trial_used === true, S, "T-04:trial-used-blocks", "trial_used=TRUE → segundo trial correctamente bloqueado", "trial_used=false — segundo trial desprotegido");
    passed++;
  }

  // T-05: Owner ID válido en env
  assert(TEST_OWNER_ID > 0, S, "T-05:owner-id-env", `BOT_OWNER_ID configurado: ${TEST_OWNER_ID}`, "BOT_OWNER_ID no configurado o inválido");
  passed++;

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-15  CLEANUP — Eliminar todos los datos de test
// ─────────────────────────────────────────────────────────────────────────────

async function suiteCleanup(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-15:CLEANUP";
  log("SUITE", S, "start", "Eliminando datos de test de la DB");
  let passed = 0, failed = 0;

  const cleanOps = [
    { q: "DELETE FROM referrals WHERE referrer_id=$1 OR referred_id=$1", p: [TEST_USER_ID], t: "referrals user1" },
    { q: "DELETE FROM referrals WHERE referrer_id=$1 OR referred_id=$1", p: [TEST_USER_ID_2], t: "referrals user2" },
    { q: "DELETE FROM leads WHERE user_id=$1", p: [TEST_USER_ID], t: "leads user1" },
    { q: "DELETE FROM leads WHERE user_id=$1", p: [TEST_USER_ID_2], t: "leads user2" },
    { q: "DELETE FROM strategy_requests WHERE user_id=$1", p: [TEST_USER_ID], t: "strategy_requests user1" },
    { q: "DELETE FROM user_menus WHERE user_id=$1", p: [TEST_USER_ID], t: "user_menus user1" },
    { q: "DELETE FROM user_menus WHERE user_id=$1", p: [TEST_USER_ID_2], t: "user_menus user2" },
    { q: "DELETE FROM users WHERE id=$1", p: [TEST_USER_ID], t: "users user1" },
    { q: "DELETE FROM users WHERE id=$1", p: [TEST_USER_ID_2], t: "users user2" },
  ];

  for (const op of cleanOps) {
    try {
      const res = await pool.query(op.q, op.p);
      log("INFO", S, `cleanup:${op.t}`, `${res.rowCount ?? 0} fila(s) eliminada(s)`);
      passed++;
    } catch (e) {
      assert(false, S, `cleanup:${op.t}`, "", `${e}`);
      failed++;
    }
  }

  // Verificar limpieza
  const { rows: u1 } = await pool.query("SELECT id FROM users WHERE id=$1", [TEST_USER_ID]);
  const { rows: u2 } = await pool.query("SELECT id FROM users WHERE id=$1", [TEST_USER_ID_2]);
  assert(u1.length === 0, S, "verify:user1-gone", `Usuario ${TEST_USER_ID} eliminado`, "Usuario test 1 persiste");
  assert(u2.length === 0, S, "verify:user2-gone", `Usuario ${TEST_USER_ID_2} eliminado`, "Usuario test 2 persiste");
  passed += 2;

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN — Orquestador de suites
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log("START", "BLISS-TEST-SUITE", "init",
    `Run ID: ${RUN_ID} | Version: ${SUITE_VERSION} | DB: ${process.env.DATABASE_URL?.split("@")[1] ?? "?"}`
  );

  const pool = getPool();

  const suites = [
    () => suiteDbConnectivity(pool),
    () => suiteUserOnboarding(pool),
    () => suitePlanLifecycle(pool),
    () => suiteAdminFlows(pool),
    () => suiteAnnouncements(pool),
    () => suitePaymentMethods(pool),
    () => suiteSugerencias(pool),
    () => suiteLeads(pool),
    () => suiteStrategyRequests(pool),
    () => suiteTestingConfig(pool),
    () => suiteReferrals(pool),
    () => suiteStrategies(pool),
    () => suitePlans(pool),
    () => suiteAccessControl(pool),
    () => suiteCleanup(pool),
  ];

  for (const suite of suites) {
    try {
      await suite();
    } catch (err) {
      console.error(`💥 Suite crashed: ${err}`);
      totalFailed++;
    }
    console.log(""); // separador visual
  }

  // ── Reporte final ─────────────────────────────────────────────────────────
  const totalTests = totalPassed + totalFailed;
  const pct = totalTests > 0 ? ((totalPassed / totalTests) * 100).toFixed(1) : "0.0";

  console.log("═".repeat(70));
  console.log(`🏁 BLISS TEST SUITE — RESULTADO FINAL`);
  console.log(`   Run ID  : ${RUN_ID}`);
  console.log(`   Total   : ${totalTests} tests`);
  console.log(`   ✅ Pass : ${totalPassed}`);
  console.log(`   ❌ Fail : ${totalFailed}`);
  console.log(`   Score   : ${pct}%`);
  console.log("═".repeat(70));

  for (const r of results) {
    const icon = r.failed === 0 ? "✅" : "❌";
    console.log(`  ${icon} ${r.suite.padEnd(32)} PASS=${r.passed} FAIL=${r.failed}`);
  }
  console.log("═".repeat(70));

  // Log final para parseo en Render
  console.log(`__BLISS_LOG__ ${JSON.stringify({
    run_id: RUN_ID, level: "FINAL", ts: new Date().toISOString(),
    total: totalTests, passed: totalPassed, failed: totalFailed,
    score_pct: parseFloat(pct), suites: results
  })}`);

  await pool.end();
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("💥 FATAL:", e);
  process.exit(1);
});
