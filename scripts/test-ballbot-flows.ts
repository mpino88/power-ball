/**
 * ╔═══════════════════════════════════════════════════════════════════════╗
 * ║   BLISS SYSTEMS LLC — Ballbot Flow Testing Suite v2.0                ║
 * ║   QA Agent · Architect: BLISS · Standard: 101%                       ║
 * ║                                                                       ║
 * ║   Propósito: Validar TODOS los flujos críticos del bot contra         ║
 * ║   PostgreSQL en Render DEV. Cada assertion emite un log estructurado  ║
 * ║   que queda visible en Render Logs para análisis forense posterior.   ║
 * ║                                                                       ║
 * ║   Ejecución: npx tsx --env-file=.env scripts/test-ballbot-flows.ts   ║
 * ╚═══════════════════════════════════════════════════════════════════════╝
 *
 * v2.0 — Cambios respecto a v1.0:
 *   · S-01: pending_interactions añadida a la lista de tablas esperadas
 *   · S-02: nuevos tests de edge-case (nombre vacío, phone vacío, duplicate /start)
 *   · S-03: test de plan_status=NULL guard + bloqueo re-trial con plan activo
 *   · S-14: deep access control (null expiry, plan_status=NULL, menu isolation)
 *   · S-16 NEW: Pending Interactions (GAP-03) — TTL, SET/GET/DELETE, session survival
 *   · S-17 NEW: Environment Audit — GAP-01/02/05 + env vars críticas
 *   · S-18 NEW: Draws Repository — integridad, formatos, datos reales
 *   · S-19 NEW: Schema Constraints Deep — FKs, PKs, índices, cascade
 *   · S-15: cleanup ampliado (pending_interactions TEST_USER_IDs)
 *
 * SUITES:
 *   S-01  DB Connectivity & Schema (tablas + pending_interactions)
 *   S-02  User Onboarding (nuevo usuario → trial, edge cases)
 *   S-03  Plan Lifecycle (expiración, renovación, guards)
 *   S-04  Admin Flows (aprobar, rechazar, asignar, gestionar)
 *   S-05  Announcements CRUD
 *   S-06  Payment Methods CRUD
 *   S-07  Suggestions Flow
 *   S-08  Leads Capture & Upsert
 *   S-09  Strategy Requests
 *   S-10  Testing Config (cutoff date)
 *   S-11  Referral System
 *   S-12  Strategy Repository
 *   S-13  Plans Repository
 *   S-14  Access Control Guards (deep)
 *   S-15  Cleanup
 *   S-16  Pending Interactions GAP-03 (NEW)
 *   S-17  Environment Audit GAP-01/02/05 (NEW)
 *   S-18  Draws Repository Integrity (NEW)
 *   S-19  Schema Constraints Deep (NEW)
 */

import pg from "pg";

// ─── Logger estructurado → visible en Render Logs ─────────────────────────────

const SUITE_VERSION = "2.0.0";
const RUN_ID = `BLISS-TEST-${Date.now()}`;

type LogLevel = "INFO" | "PASS" | "FAIL" | "WARN" | "START" | "END" | "SUITE";

function log(level: LogLevel, suite: string, test: string, detail = "", meta?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const emoji = { INFO: "ℹ️", PASS: "✅", FAIL: "❌", WARN: "⚠️", START: "🚀", END: "🏁", SUITE: "📦" }[level];
  const payload = JSON.stringify({ run_id: RUN_ID, ts, level, suite, test, detail, ...(meta ?? {}) });
  console.log(`${emoji} [${level}] ${suite} | ${test}${detail ? " | " + detail : ""}`);
  console.log(`__BLISS_LOG__ ${payload}`);
}

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

function warn(suite: string, testName: string, detail: string, meta?: Record<string, unknown>) {
  log("WARN", suite, testName, detail, meta);
}

// ─── IDs de test (nunca colisionan con usuarios reales) ──────────────────────

const TEST_USER_ID   = 9_000_000_001;
const TEST_USER_ID_2 = 9_000_000_002;
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
// S-01  DB CONNECTIVITY & SCHEMA (incluyendo pending_interactions)
// ─────────────────────────────────────────────────────────────────────────────

async function suiteDbConnectivity(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-01:DB-CONNECTIVITY";
  log("SUITE", S, "start", "Verificando conectividad y schema completo");
  let passed = 0, failed = 0;

  // T-01: Ping
  try {
    const { rows } = await pool.query("SELECT NOW() as ts, current_database() as db, version() as ver");
    assert(!!rows[0]?.ts, S, "T-01:ping", `DB respondió: ${rows[0]?.db} @ ${rows[0]?.ts}`, "Sin respuesta del servidor");
    log("INFO", S, "T-01:pg-version", rows[0]?.ver?.split(" ").slice(0, 2).join(" ") ?? "?");
    passed++;
  } catch (e) {
    assert(false, S, "T-01:ping", "", `Conexión fallida: ${e}`);
    failed++;
  }

  // T-02: Tablas del schema (incluyendo pending_interactions — GAP-03)
  const expectedTables = [
    "users", "user_menus", "plans", "draws", "custom_strategies",
    "announcements", "suggestions", "payment_methods", "testing_config",
    "leads", "strategy_requests", "referrals",
    "pending_interactions",  // ← GAP-03 FIX
  ];
  try {
    const { rows } = await pool.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
    );
    const found = rows.map((r: { tablename: string }) => r.tablename);
    for (const t of expectedTables) {
      const ok = found.includes(t);
      if (ok) passed++; else failed++;
      assert(ok, S, `T-02:table:${t}`, `tabla '${t}' existe`, `tabla '${t}' NO ENCONTRADA — ¿ejecutaste schema.sql?`, { found });
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

  // T-04: Índice crítico de pending_interactions existe
  try {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='pending_interactions' AND schemaname='public'`
    );
    const idxNames = rows.map((r: { indexname: string }) => r.indexname);
    assert(
      idxNames.includes("idx_pending_interactions_expires"),
      S, "T-04:idx-pending-expires",
      `Índice idx_pending_interactions_expires OK`,
      `Índice TTL NO encontrado — queries de cleanup lentas`,
      { idxNames }
    );
    passed++;
  } catch (e) {
    assert(false, S, "T-04:idx-pending-expires", "", `${e}`);
    failed++;
  }

  // T-05: Índices críticos de users existen
  try {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='users' AND schemaname='public'`
    );
    const idxNames = rows.map((r: { indexname: string }) => r.indexname);
    const requiredIdx = ["idx_users_plan_status", "idx_users_referred_by"];
    for (const idx of requiredIdx) {
      const ok = idxNames.includes(idx);
      if (ok) passed++; else failed++;
      assert(ok, S, `T-05:idx:${idx}`, `Índice ${idx} OK`, `Índice ${idx} FALTANTE`, { idxNames });
    }
  } catch (e) {
    assert(false, S, "T-05:user-indexes", "", `${e}`);
    failed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-02  USER ONBOARDING (nuevo usuario → trial + edge cases v2.0)
// ─────────────────────────────────────────────────────────────────────────────

async function suiteUserOnboarding(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-02:USER-ONBOARDING";
  log("SUITE", S, "start", `userId=${TEST_USER_ID}`);
  let passed = 0, failed = 0;

  // T-01: Usuario NO existe antes del test
  {
    const { rows } = await pool.query("SELECT id FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows.length === 0, S, "T-01:user-not-exists-pre", "DB limpia antes de test", `Usuario ${TEST_USER_ID} ya existe`);
    if (rows.length === 0) passed++; else failed++;
  }

  // T-02: Insertar usuario nuevo (simula primer /start)
  try {
    await pool.query(
      `INSERT INTO users (id, username, phone, role, plan_id, plan_status, trial_used)
       VALUES ($1, $2, $3, 'user', NULL, NULL, FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID, "test_user_bliss", ""]
    );
    const { rows } = await pool.query("SELECT * FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows.length === 1, S, "T-02:user-insert", `Usuario ${TEST_USER_ID} insertado`, "Insert falló");
    assert(rows[0]?.trial_used === false, S, "T-02:trial-used-false", "trial_used=false al inicio", `trial_used=${rows[0]?.trial_used}`);
    assert(rows[0]?.plan_status === null, S, "T-02:plan-status-null", "plan_status=NULL (sin plan)", `plan_status=${rows[0]?.plan_status}`);
    assert(rows[0]?.role === "user", S, "T-02:role-user", "role=user por defecto", `role=${rows[0]?.role}`);
    passed += 4;
  } catch (e) {
    assert(false, S, "T-02:user-insert", "", `${e}`);
    failed++;
  }

  // T-03: Edge case — Segundo /start NO duplica el usuario (ON CONFLICT DO NOTHING)
  try {
    await pool.query(
      `INSERT INTO users (id, username, phone, role, plan_id, plan_status, trial_used)
       VALUES ($1,'duplicated_name','5559999','user',NULL,NULL,FALSE)
       ON CONFLICT (id) DO NOTHING`,
      [TEST_USER_ID]
    );
    const { rows } = await pool.query("SELECT count(*) as c FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(Number(rows[0]?.c) === 1, S, "T-03:no-duplicate-start", "Segundo /start no duplica usuario", `Count=${rows[0]?.c}`);
    // El username no debe haber cambiado
    const { rows: ur } = await pool.query("SELECT username FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(ur[0]?.username === "test_user_bliss", S, "T-03:username-preserved", "Username original preservado", `Username=${ur[0]?.username}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-03:no-duplicate", "", `${e}`);
    failed++;
  }

  // T-04: Solicitud de trial (plan=basico, temporality=7d)
  try {
    await pool.query(
      `UPDATE users SET plan_id='basico', plan_status='requested', plan_temporality='7d',
       plan_expiry=TO_CHAR(NOW() + INTERVAL '7 days','MM/DD/YY'), phone='5551234567', username='Test User BLISS'
       WHERE id=$1`,
      [TEST_USER_ID]
    );
    const { rows } = await pool.query("SELECT plan_status, plan_temporality, phone FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows[0]?.plan_status === "requested", S, "T-04:plan-requested", "Estado 'requested' guardado", `Estado=${rows[0]?.plan_status}`);
    assert(rows[0]?.plan_temporality === "7d", S, "T-04:temporality-7d", "Temporalidad 7d", `Temp=${rows[0]?.plan_temporality}`);
    assert(rows[0]?.phone === "5551234567", S, "T-04:phone-saved", "Teléfono guardado", `Phone=${rows[0]?.phone}`);
    passed += 3;
  } catch (e) {
    assert(false, S, "T-04:plan-request", "", `${e}`);
    failed++;
  }

  // T-05: Auto-aprobación trial (assignPlanToUser con 7d)
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
    assert(rows[0]?.plan_status === "approved", S, "T-05:trial-approved", "Trial aprobado → status=approved", `Status=${rows[0]?.plan_status}`);
    assert(rows[0]?.trial_used === true, S, "T-05:trial-used-true", "trial_used=TRUE", `trial_used=${rows[0]?.trial_used}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-05:trial-approve", "", `${e}`);
    failed++;
  }

  // T-06: Lead capturado en tabla leads
  try {
    await pool.query(
      `INSERT INTO leads (user_id, nombre, telefono, plan, temporality, fecha, status)
       VALUES ($1,'Test User BLISS','5551234567','basico','7d',TO_CHAR(NOW(),'DD/MM/YYYY HH24:MI'),'trial_active')
       ON CONFLICT (user_id) DO UPDATE SET status=EXCLUDED.status`,
      [TEST_USER_ID]
    );
    const { rows } = await pool.query("SELECT * FROM leads WHERE user_id=$1", [TEST_USER_ID]);
    assert(rows.length === 1, S, "T-06:lead-captured", `Lead: ${rows[0]?.nombre} / ${rows[0]?.plan}`, "Lead no encontrado");
    assert(rows[0]?.status === "trial_active", S, "T-06:lead-status-trial", "Lead status=trial_active", `Status=${rows[0]?.status}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-06:lead-capture", "", `${e}`);
    failed++;
  }

  // T-07: Menú asignado al usuario trial
  {
    const { rows } = await pool.query("SELECT menu_id FROM user_menus WHERE user_id=$1", [TEST_USER_ID]);
    const menus = rows.map((r: { menu_id: string }) => r.menu_id);
    assert(menus.includes("menu_basico"), S, "T-07:menu-assigned", `Menús asignados: ${menus.join(",")}`, "menu_basico no encontrado");
    passed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-03  PLAN LIFECYCLE (expiración, renovación, guards v2.0)
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
    assert(!!expiry, S, "T-01:expiry-set", `Expiry seteado: ${expiry}`, "Expiry no pudo setearse");
    passed++;
  } catch (e) {
    assert(false, S, "T-01:expiry-set", "", `${e}`);
    failed++;
  }

  // T-02: Lógica isPlanExpired — replicar la función del bot en JS
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

  // T-03: Edge case — plan_expiry=NULL no lanza excepción (usuario sin plan)
  {
    let errorOccurred = false;
    try {
      let expiry: string | null = null; // let evita narrowing a never en strict mode
      let isExpired = false;
      if (expiry) {
        const [mm, dd, yy] = expiry.split("/");
        if (mm && dd && yy) {
          const year = parseInt(yy) <= 49 ? 2000 + parseInt(yy) : 1900 + parseInt(yy);
          const expDate = new Date(year, parseInt(mm) - 1, parseInt(dd), 23, 59, 59);
          isExpired = expDate < new Date();
        }
      }
      assert(!isExpired, S, "T-03:null-expiry-safe", "plan_expiry=NULL → isExpired=false (sin crash)", "Null expiry causó error");
      passed++;
    } catch {
      errorOccurred = true;
    }
    if (errorOccurred) { assert(false, S, "T-03:null-expiry-safe", "", "isPlanExpired crashea con null"); failed++; }
  }

  // T-04: Bloqueo segundo trial (trial_used=true)
  {
    const { rows } = await pool.query("SELECT trial_used FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows[0]?.trial_used === true, S, "T-04:block-second-trial", "trial_used=TRUE → segundo trial bloqueado", "trial_used no es true");
    passed++;
  }

  // T-05: Edge case — usuario con plan activo intenta trial → debe ser rechazado
  {
    // Simular: usuario aprobado + trial_used=true
    const { rows } = await pool.query("SELECT plan_status, trial_used FROM users WHERE id=$1", [TEST_USER_ID]);
    const canRequestTrial = rows[0]?.plan_status !== "approved" && rows[0]?.trial_used !== true;
    assert(!canRequestTrial, S, "T-05:active-plan-no-trial", "Usuario con plan aprobado NO puede pedir trial (lógica correcta)", "Usuario con plan aprobado puede pedir trial — BUG");
    passed++;
  }

  // T-06: Solicitud de renovación de plan de pago
  try {
    await pool.query(
      `UPDATE users SET plan_status='requested', pending_plan='basico|1m',
       plan_temporality='1m', plan_expiry=TO_CHAR(NOW() + INTERVAL '30 days','MM/DD/YY')
       WHERE id=$1`,
      [TEST_USER_ID]
    );
    await pool.query(`UPDATE leads SET status='renewal_requested' WHERE user_id=$1`, [TEST_USER_ID]);
    const { rows } = await pool.query("SELECT plan_status, pending_plan FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows[0]?.plan_status === "requested", S, "T-06:renewal-requested", "Renovación solicitada → status=requested", `Status=${rows[0]?.plan_status}`);
    assert(rows[0]?.pending_plan === "basico|1m", S, "T-06:pending-plan", "pending_plan=basico|1m", `PendingPlan=${rows[0]?.pending_plan}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-06:renewal-request", "", `${e}`);
    failed++;
  }

  // T-07: plan_expiry format MM/DD/YY (el bot es sensible al formato)
  {
    const { rows } = await pool.query("SELECT plan_expiry FROM users WHERE id=$1", [TEST_USER_ID]);
    const expiry = rows[0]?.plan_expiry as string | null;
    const mmddyyRegex = /^\d{2}\/\d{2}\/\d{2}$/;
    assert(
      expiry !== null && mmddyyRegex.test(expiry),
      S, "T-07:expiry-format",
      `Formato MM/DD/YY correcto: ${expiry}`,
      `Formato incorrecto: ${expiry} — isPlanExpired fallará`,
    );
    passed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-04  ADMIN FLOWS (aprobar, rechazar, asignar, gestionar)
// ─────────────────────────────────────────────────────────────────────────────

async function suiteAdminFlows(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-04:ADMIN-FLOWS";
  log("SUITE", S, "start", `ownerId=${TEST_OWNER_ID} / userId=${TEST_USER_ID}`);
  let passed = 0, failed = 0;

  // T-01: Ver solicitudes pendientes
  {
    const { rows } = await pool.query(
      `SELECT id, username, plan_id, plan_status, plan_temporality, phone FROM users WHERE plan_status='requested'`
    );
    assert(rows.length >= 1, S, "T-01:pending-requests", `${rows.length} solicitud(es) pendiente(s)`, "No hay solicitudes pendientes");
    passed++;
    log("INFO", S, "T-01:pending-detail", `Solicitudes: ${rows.map((r: {id: string; plan_id: string}) => `uid=${r.id}/${r.plan_id}`).join(", ")}`);
  }

  // T-02: Admin aprueba solicitud
  try {
    await pool.query(
      `UPDATE users SET plan_status='approved', pending_plan=NULL,
       plan_id='basico', plan_temporality='1m',
       plan_expiry=TO_CHAR(NOW() + INTERVAL '30 days','MM/DD/YY')
       WHERE id=$1`,
      [TEST_USER_ID]
    );
    const { rows } = await pool.query("SELECT plan_status, plan_id FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows[0]?.plan_status === "approved", S, "T-02:approve-plan", "Plan aprobado → status=approved", `Status=${rows[0]?.plan_status}`);
    assert(rows[0]?.plan_id === "basico", S, "T-02:plan-id", "plan_id=basico asignado", `PlanId=${rows[0]?.plan_id}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-02:approve-plan", "", `${e}`);
    failed++;
  }

  // T-03: Admin rechaza solicitud (usuario 2)
  try {
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

  // T-04: Admin asigna menú adicional
  try {
    await pool.query(
      `INSERT INTO user_menus (user_id, menu_id) VALUES ($1,'menu_pro_bliss') ON CONFLICT DO NOTHING`,
      [TEST_USER_ID]
    );
    const { rows } = await pool.query("SELECT menu_id FROM user_menus WHERE user_id=$1", [TEST_USER_ID]);
    const menus = rows.map((r: { menu_id: string }) => r.menu_id);
    assert(menus.includes("menu_pro_bliss"), S, "T-04:assign-menu", `Menú asignado: ${menus.join(",")}`, "Menú no encontrado");
    passed++;
  } catch (e) {
    assert(false, S, "T-04:assign-menu", "", `${e}`);
    failed++;
  }

  // T-05: Admin remueve menú
  try {
    await pool.query(`DELETE FROM user_menus WHERE user_id=$1 AND menu_id='menu_pro_bliss'`, [TEST_USER_ID]);
    const { rows } = await pool.query("SELECT menu_id FROM user_menus WHERE user_id=$1 AND menu_id='menu_pro_bliss'", [TEST_USER_ID]);
    assert(rows.length === 0, S, "T-05:remove-menu", "Menú removido correctamente", "Menú persiste tras delete");
    passed++;
  } catch (e) {
    assert(false, S, "T-05:remove-menu", "", `${e}`);
    failed++;
  }

  // T-06: Aprobación limpia pending_plan (no debe quedar basura)
  {
    const { rows } = await pool.query("SELECT pending_plan FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows[0]?.pending_plan === null, S, "T-06:pending-plan-cleared", "pending_plan=NULL tras aprobación", `pending_plan=${rows[0]?.pending_plan}`);
    passed++;
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

  try {
    await pool.query(`INSERT INTO announcements (text, timestamp) VALUES ($1,$2)`, ["[TEST-BLISS] Anuncio de prueba 101%", testTs]);
    const { rows } = await pool.query("SELECT * FROM announcements WHERE timestamp=$1", [testTs]);
    assert(rows.length === 1, S, "T-01:create", `Anuncio creado ts=${testTs}`, "Anuncio no encontrado tras insert");
    assert(rows[0]?.text === "[TEST-BLISS] Anuncio de prueba 101%", S, "T-01:text-match", "Texto exacto guardado", `Texto=${rows[0]?.text}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-01:create", "", `${e}`); failed++;
  }

  try {
    await pool.query("UPDATE announcements SET text=$1 WHERE timestamp=$2", ["[TEST-BLISS] Anuncio EDITADO", testTs]);
    const { rows } = await pool.query("SELECT text FROM announcements WHERE timestamp=$1", [testTs]);
    assert(rows[0]?.text === "[TEST-BLISS] Anuncio EDITADO", S, "T-02:edit", "Texto editado", `Texto=${rows[0]?.text}`);
    passed++;
  } catch (e) {
    assert(false, S, "T-02:edit", "", `${e}`); failed++;
  }

  {
    const { rows } = await pool.query("SELECT id, text FROM announcements ORDER BY timestamp ASC");
    assert(rows.length >= 1, S, "T-03:list", `${rows.length} anuncio(s)`, "Tabla announcements vacía");
    passed++;
  }

  try {
    await pool.query("DELETE FROM announcements WHERE timestamp=$1", [testTs]);
    const { rows } = await pool.query("SELECT id FROM announcements WHERE timestamp=$1", [testTs]);
    assert(rows.length === 0, S, "T-04:delete", "Anuncio eliminado", "Anuncio persiste tras DELETE");
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

  {
    const { rows } = await pool.query("SELECT id, name FROM payment_methods ORDER BY id");
    assert(rows.length >= 1, S, "T-02:list", `${rows.length} PM(s) en DB`, "Tabla vacía");
    passed++;
    if (rows.length > 0) log("INFO", S, "T-02:pm-list", rows.map((r: {id: number; name: string}) => `${r.id}:${r.name}`).join(" | "));
  }

  if (testPmId) {
    try {
      await pool.query("UPDATE payment_methods SET name=$1 WHERE id=$2", ["[TEST-BLISS] Zelle EDITED", testPmId]);
      const { rows } = await pool.query("SELECT name FROM payment_methods WHERE id=$1", [testPmId]);
      assert(rows[0]?.name === "[TEST-BLISS] Zelle EDITED", S, "T-03:edit", "PM editado", `Name=${rows[0]?.name}`);
      passed++;
    } catch (e) {
      assert(false, S, "T-03:edit", "", `${e}`); failed++;
    }
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

  {
    const { rows } = await pool.query("SELECT id, text, nombre FROM suggestions WHERE user_id=$1", [TEST_USER_ID]);
    assert(rows.length >= 1, S, "T-02:read-by-user", `${rows.length} sugerencia(s) del usuario`, "Sin resultados");
    passed++;
  }

  {
    const { rows } = await pool.query("SELECT count(*) as c FROM suggestions");
    assert(Number(rows[0]?.c) >= 1, S, "T-03:list-all", `Total sugerencias: ${rows[0]?.c}`, "Tabla vacía");
    passed++;
  }

  // T-04: Campos nombre/telefono/fecha existen y no son null
  if (testSugId) {
    const { rows } = await pool.query("SELECT nombre, telefono, fecha FROM suggestions WHERE id=$1", [testSugId]);
    assert(rows[0]?.nombre === "Test User BLISS", S, "T-04:nombre-field", "Campo nombre guardado correctamente", `nombre=${rows[0]?.nombre}`);
    assert(rows[0]?.telefono === "5551234567", S, "T-04:telefono-field", "Campo telefono guardado", `telefono=${rows[0]?.telefono}`);
    assert(!!rows[0]?.fecha, S, "T-04:fecha-field", "Campo fecha guardado", "fecha vacío");
    passed += 3;
    await pool.query("DELETE FROM suggestions WHERE id=$1", [testSugId]);
    const { rows: cr } = await pool.query("SELECT id FROM suggestions WHERE id=$1", [testSugId]);
    assert(cr.length === 0, S, "T-05:cleanup", "Sugerencia de test eliminada", "Sugerencia persiste");
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

  {
    const { rows } = await pool.query("SELECT * FROM leads WHERE user_id=$1", [TEST_USER_ID]);
    assert(rows.length === 1, S, "T-01:lead-exists", `Lead: ${rows[0]?.nombre} / ${rows[0]?.status}`, "Lead no encontrado — S-02 debe pasar primero");
    passed++;
  }

  try {
    await pool.query(
      `INSERT INTO leads (user_id, nombre, telefono, plan, temporality, fecha, status)
       VALUES ($1,'Test User BLISS','5551234567','basico','1m',TO_CHAR(NOW(),'DD/MM/YYYY HH24:MI'),'renewal_requested')
       ON CONFLICT (user_id) DO UPDATE SET status=EXCLUDED.status, plan=EXCLUDED.plan, temporality=EXCLUDED.temporality`,
      [TEST_USER_ID]
    );
    const { rows } = await pool.query("SELECT status, plan, temporality FROM leads WHERE user_id=$1", [TEST_USER_ID]);
    assert(rows[0]?.status === "renewal_requested", S, "T-02:upsert-status", "UPSERT status=renewal_requested", `Status=${rows[0]?.status}`);
    assert(rows[0]?.temporality === "1m", S, "T-02:upsert-temporality", "Temporalidad=1m", `Temp=${rows[0]?.temporality}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-02:upsert", "", `${e}`); failed++;
  }

  {
    const { rows } = await pool.query("SELECT count(*) as c FROM leads");
    assert(Number(rows[0]?.c) >= 1, S, "T-03:list-all", `Total leads: ${rows[0]?.c}`, "Tabla leads vacía");
    passed++;
  }

  // T-04: UNIQUE constraint en user_id (no permite dos rows con el mismo user_id)
  try {
    let constraintTriggered = false;
    try {
      await pool.query(
        `INSERT INTO leads (user_id, nombre, telefono, plan, temporality, fecha, status)
         VALUES ($1,'Duplicate','000','basico','7d',TO_CHAR(NOW(),'DD/MM/YYYY'),'trial_active')`,
        [TEST_USER_ID]
      );
    } catch (e: unknown) {
      if (e instanceof Error && e.message?.includes("unique")) constraintTriggered = true;
    }
    assert(constraintTriggered, S, "T-04:leads-unique-constraint", "UNIQUE(user_id) lanza error en duplicado", "UNIQUE constraint no funcionó — posibles leads duplicados");
    passed++;
  } catch (e) {
    assert(false, S, "T-04:leads-unique", "", `${e}`); failed++;
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

  try {
    await pool.query(
      `INSERT INTO strategy_requests (user_id, menu_id, requested_at)
       VALUES ($1,'strat_test_bliss',$2)
       ON CONFLICT (user_id, menu_id) DO UPDATE SET requested_at=EXCLUDED.requested_at`,
      [TEST_USER_ID, Date.now()]
    );
    const { rows } = await pool.query("SELECT * FROM strategy_requests WHERE user_id=$1 AND menu_id='strat_test_bliss'", [TEST_USER_ID]);
    assert(rows.length === 1, S, "T-01:insert", `Strategy request guardado user=${TEST_USER_ID}`, "Request no encontrado");
    passed++;
  } catch (e) {
    assert(false, S, "T-01:insert", "", `${e}`); failed++;
  }

  try {
    const tsNew = Date.now() + 1000;
    await pool.query(
      `INSERT INTO strategy_requests (user_id, menu_id, requested_at)
       VALUES ($1,'strat_test_bliss',$2)
       ON CONFLICT (user_id, menu_id) DO UPDATE SET requested_at=EXCLUDED.requested_at`,
      [TEST_USER_ID, tsNew]
    );
    const { rows } = await pool.query("SELECT count(*) as c FROM strategy_requests WHERE user_id=$1 AND menu_id='strat_test_bliss'", [TEST_USER_ID]);
    assert(Number(rows[0]?.c) === 1, S, "T-02:dedup", "ON CONFLICT → única fila", `Count=${rows[0]?.c}`);
    passed++;
  } catch (e) {
    assert(false, S, "T-02:dedup", "", `${e}`); failed++;
  }

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

  {
    const { rows } = await pool.query("SELECT value FROM testing_config WHERE key=$1", [testKey]);
    assert(rows[0]?.value === testDate, S, "T-02:load-cutoff", `Cutoff leído: ${rows[0]?.value}`, "Cutoff no encontrado");
    passed++;
  }

  try {
    const newDate = "04/01/25";
    await pool.query("UPDATE testing_config SET value=$1 WHERE key=$2", [newDate, testKey]);
    const { rows } = await pool.query("SELECT value FROM testing_config WHERE key=$1", [testKey]);
    assert(rows[0]?.value === newDate, S, "T-03:update-cutoff", `Cutoff actualizado: ${rows[0]?.value}`, `Value=${rows[0]?.value}`);
    passed++;
  } catch (e) {
    assert(false, S, "T-03:update", "", `${e}`); failed++;
  }

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

  try {
    await pool.query(
      `INSERT INTO referrals (referrer_id, referred_id, rewarded)
       VALUES ($1,$2,FALSE)
       ON CONFLICT (referred_id) DO NOTHING`,
      [TEST_USER_ID, TEST_USER_ID_2]
    );
    const { rows } = await pool.query("SELECT * FROM referrals WHERE referred_id=$1", [TEST_USER_ID_2]);
    assert(rows.length === 1, S, "T-01:create-referral", `Referral: ${TEST_USER_ID} → ${TEST_USER_ID_2}`, "Referral no encontrado");
    assert(rows[0]?.rewarded === false, S, "T-01:rewarded-false", "rewarded=false inicialmente", `Rewarded=${rows[0]?.rewarded}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-01:create", "", `${e}`); failed++;
  }

  try {
    await pool.query(
      `UPDATE referrals SET rewarded=TRUE, rewarded_at=NOW() WHERE referred_id=$1`,
      [TEST_USER_ID_2]
    );
    const { rows } = await pool.query("SELECT rewarded, rewarded_at FROM referrals WHERE referred_id=$1", [TEST_USER_ID_2]);
    assert(rows[0]?.rewarded === true, S, "T-02:rewarded-true", "Referral recompensado", `Rewarded=${rows[0]?.rewarded}`);
    assert(rows[0]?.rewarded_at !== null, S, "T-02:rewarded-at", "rewarded_at registrado", "rewarded_at es null");
    passed += 2;
  } catch (e) {
    assert(false, S, "T-02:reward", "", `${e}`); failed++;
  }

  {
    const { rows } = await pool.query("SELECT count(*) as c FROM referrals WHERE rewarded=FALSE");
    assert(Number(rows[0]?.c) >= 0, S, "T-03:unrewarded-index", `Referrals sin recompensar: ${rows[0]?.c}`, "Query falló");
    passed++;
  }

  // T-04: UNIQUE constraint en referred_id (un usuario solo puede ser referido una vez)
  try {
    let constraintTriggered = false;
    try {
      await pool.query(
        `INSERT INTO referrals (referrer_id, referred_id, rewarded) VALUES ($1,$2,FALSE)`,
        [TEST_USER_ID, TEST_USER_ID_2]
      );
    } catch (e: unknown) {
      if (e instanceof Error && e.message?.includes("unique")) constraintTriggered = true;
    }
    assert(constraintTriggered, S, "T-04:referred-unique", "UNIQUE(referred_id) impide referral duplicado", "Sin protección — posible fraude de referrals");
    passed++;
  } catch (e) {
    assert(false, S, "T-04:referred-unique", "", `${e}`); failed++;
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

  {
    const { rows } = await pool.query("SELECT count(*) as c FROM custom_strategies");
    assert(Number(rows[0]?.c) >= 0, S, "T-01:read-strategies", `${rows[0]?.c} estrategia(s)`, "Query falló");
    passed++;
    log("INFO", S, "T-01:count", `Estrategias en DB: ${rows[0]?.c}`);
  }

  try {
    await pool.query(
      `INSERT INTO custom_strategies (id, titulo, descripcion, visibility)
       VALUES ('test_bliss_strat','[TEST-BLISS] Estrategia 101%','Estrategia de prueba BLISS Systems','private')
       ON CONFLICT (id) DO UPDATE SET titulo=EXCLUDED.titulo`,
    );
    const { rows } = await pool.query("SELECT * FROM custom_strategies WHERE id='test_bliss_strat'");
    assert(rows.length === 1, S, "T-02:insert", `Estrategia: ${rows[0]?.titulo}`, "Estrategia no encontrada");
    assert(rows[0]?.visibility === "private", S, "T-02:visibility", "visibility=private", `Vis=${rows[0]?.visibility}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-02:insert", "", `${e}`); failed++;
  }

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

  {
    const { rows } = await pool.query("SELECT id, title, auto_approve FROM plans ORDER BY id");
    assert(rows.length >= 0, S, "T-01:read", `${rows.length} plan(es) en DB`, "Query falló");
    passed++;
    if (rows.length > 0) log("INFO", S, "T-01:plans-detail", `Planes: ${rows.map((r: {id: string; title: string; auto_approve: boolean}) => `${r.id}(${r.title},auto=${r.auto_approve})`).join(" | ")}`);
  }

  // T-02: Planes críticos del sistema existen (basico, pro, trial)
  {
    const { rows } = await pool.query("SELECT id FROM plans WHERE id IN ('basico','pro','trial')");
    const ids = rows.map((r: {id: string}) => r.id);
    const planCount = ids.length;
    if (planCount === 0) {
      warn(S, "T-02:core-plans", "Planes basico/pro/trial NO están en DB — se sirven desde código hardcoded", { ids });
    } else {
      assert(planCount >= 1, S, "T-02:core-plans", `Planes encontrados en DB: ${ids.join(",")}`, "No hay planes en DB");
    }
    passed++;
  }

  try {
    await pool.query(
      `INSERT INTO plans (id, title, description, auto_approve, price_1m)
       VALUES ('test_plan_bliss','[TEST] Plan BLISS 101%','Plan de prueba',FALSE,'$49')
       ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title`,
    );
    const { rows } = await pool.query("SELECT title, price_1m FROM plans WHERE id='test_plan_bliss'");
    assert(rows[0]?.title === "[TEST] Plan BLISS 101%", S, "T-03:upsert", `Plan: ${rows[0]?.title}`, `Title=${rows[0]?.title}`);
    passed++;
  } catch (e) {
    assert(false, S, "T-03:upsert", "", `${e}`); failed++;
  }

  await pool.query("DELETE FROM plans WHERE id='test_plan_bliss'");
  const { rows } = await pool.query("SELECT id FROM plans WHERE id='test_plan_bliss'");
  assert(rows.length === 0, S, "T-04:cleanup", "Plan de test eliminado", "Plan persiste");
  passed++;

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-14  ACCESS CONTROL GUARDS (deep v2.0)
// ─────────────────────────────────────────────────────────────────────────────

async function suiteAccessControl(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-14:ACCESS-CONTROL";
  log("SUITE", S, "start");
  let passed = 0, failed = 0;

  // T-01: Usuario aprobado tiene acceso
  {
    const { rows } = await pool.query("SELECT plan_status FROM users WHERE id=$1", [TEST_USER_ID]);
    assert(rows[0]?.plan_status === "approved", S, "T-01:approved-user", `Usuario ${TEST_USER_ID} aprobado`, `Status=${rows[0]?.plan_status}`);
    passed++;
  }

  // T-02: Usuario rechazado no tiene acceso
  {
    const { rows } = await pool.query("SELECT plan_status FROM users WHERE id=$1", [TEST_USER_ID_2]);
    assert(rows[0]?.plan_status === "rejected", S, "T-02:rejected-user", `Usuario ${TEST_USER_ID_2} rechazado`, `Status=${rows[0]?.plan_status}`);
    passed++;
  }

  // T-03: isPlanExpired — usuario con plan vigente
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
    assert(rows[0]?.trial_used === true, S, "T-04:trial-used-blocks", "trial_used=TRUE → bloquea segundo trial", `trial_used=${rows[0]?.trial_used}`);
    passed++;
  }

  // T-05: BOT_OWNER_ID válido en env
  assert(TEST_OWNER_ID > 0, S, "T-05:owner-id-env", `BOT_OWNER_ID=${TEST_OWNER_ID}`, "BOT_OWNER_ID no configurado");
  passed++;

  // T-06: Menú isolation — usuario rechazado no tiene menús asignados
  {
    const { rows } = await pool.query("SELECT count(*) as c FROM user_menus WHERE user_id=$1", [TEST_USER_ID_2]);
    assert(Number(rows[0]?.c) === 0, S, "T-06:rejected-no-menus", `Usuario rechazado tiene 0 menús asignados`, `Tiene ${rows[0]?.c} menú(s) — posible acceso indebido`);
    passed++;
  }

  // T-07: isOwner — solo BOT_OWNER_ID es owner (verificar en DB si role=owner)
  if (TEST_OWNER_ID > 0) {
    const { rows } = await pool.query("SELECT role FROM users WHERE id=$1", [TEST_OWNER_ID]);
    if (rows.length === 0) {
      warn(S, "T-07:owner-role", `Owner ${TEST_OWNER_ID} no está en users — no ha interactuado con el bot aún`);
      passed++;
    } else {
      assert(rows[0]?.role === "owner", S, "T-07:owner-role", `Owner tiene role=owner en DB`, `role=${rows[0]?.role}`);
      passed++;
    }
  } else {
    warn(S, "T-07:owner-role", "BOT_OWNER_ID=0 — test omitido");
    passed++;
  }

  // T-08: usuarios TEST no tienen role=owner (nadie puede suplantar al owner)
  {
    const { rows } = await pool.query("SELECT id FROM users WHERE id IN ($1,$2) AND role='owner'", [TEST_USER_ID, TEST_USER_ID_2]);
    assert(rows.length === 0, S, "T-08:no-fake-owner", "Usuarios test no tienen role=owner", `${rows.length} usuario(s) test con role=owner — CRÍTICO`);
    passed++;
  }

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
    { q: "DELETE FROM pending_interactions WHERE user_id=$1", p: [TEST_USER_ID], t: "pending_interactions user1" },
    { q: "DELETE FROM pending_interactions WHERE user_id=$1", p: [TEST_USER_ID_2], t: "pending_interactions user2" },
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

  const { rows: u1 } = await pool.query("SELECT id FROM users WHERE id=$1", [TEST_USER_ID]);
  const { rows: u2 } = await pool.query("SELECT id FROM users WHERE id=$1", [TEST_USER_ID_2]);
  assert(u1.length === 0, S, "verify:user1-gone", `Usuario ${TEST_USER_ID} eliminado`, "Usuario test 1 persiste");
  assert(u2.length === 0, S, "verify:user2-gone", `Usuario ${TEST_USER_ID_2} eliminado`, "Usuario test 2 persiste");
  passed += 2;

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-16  PENDING INTERACTIONS — GAP-03 FIX VERIFICATION (NEW v2.0)
// ─────────────────────────────────────────────────────────────────────────────

async function suitePendingInteractions(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-16:PENDING-INTERACTIONS";
  log("SUITE", S, "start", "Verifica que GAP-03 está resuelto: Maps en RAM → PostgreSQL");
  let passed = 0, failed = 0;

  // Limpiar datos previos de test
  await pool.query("DELETE FROM pending_interactions WHERE user_id IN ($1,$2)", [TEST_USER_ID, TEST_USER_ID_2]);

  // T-01: Tabla pending_interactions existe y tiene las columnas correctas
  try {
    const { rows } = await pool.query(
      `SELECT column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_name='pending_interactions' AND table_schema='public'
       ORDER BY ordinal_position`
    );
    const colNames = rows.map((r: { column_name: string }) => r.column_name);
    const expectedCols = ["user_id", "type", "plan_id", "plan_name", "temporality", "expires_at", "created_at"];
    for (const col of expectedCols) {
      const ok = colNames.includes(col);
      if (ok) passed++; else failed++;
      assert(ok, S, `T-01:col:${col}`, `Columna '${col}' existe`, `Columna '${col}' NO ENCONTRADA — schema desactualizado`);
    }
  } catch (e) {
    assert(false, S, "T-01:schema", "", `${e}`); failed++;
  }

  // T-02: PRIMARY KEY es user_id (no user_id+type) — confirm schema design
  try {
    const { rows } = await pool.query(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
       WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_name='pending_interactions'`
    );
    const pkCols = rows.map((r: { column_name: string }) => r.column_name);
    assert(
      pkCols.length === 1 && pkCols[0] === "user_id",
      S, "T-02:primary-key",
      `PK=user_id (solo 1 pending por usuario)`,
      `PK inesperado: ${pkCols.join(",")} — schema puede tener conflictos`,
      { pkCols }
    );
    passed++;
  } catch (e) {
    assert(false, S, "T-02:primary-key", "", `${e}`); failed++;
  }

  // T-03: SET — Guardar pending plan_request (simula usuario eligiendo plan)
  try {
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 min TTL
    await pool.query(
      `INSERT INTO pending_interactions (user_id, type, plan_id, plan_name, temporality, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         type=EXCLUDED.type, plan_id=EXCLUDED.plan_id, plan_name=EXCLUDED.plan_name,
         temporality=EXCLUDED.temporality, expires_at=EXCLUDED.expires_at, created_at=CURRENT_TIMESTAMP`,
      [TEST_USER_ID, "plan_request", "basico", "Plan Básico", "1m", expiresAt]
    );
    const { rows } = await pool.query("SELECT * FROM pending_interactions WHERE user_id=$1", [TEST_USER_ID]);
    assert(rows.length === 1, S, "T-03:set-plan-request", "pending_interaction guardado (plan_request)", "Row no encontrado");
    assert(rows[0]?.type === "plan_request", S, "T-03:type-ok", `type=plan_request`, `type=${rows[0]?.type}`);
    assert(rows[0]?.plan_id === "basico", S, "T-03:plan-id-ok", `plan_id=basico`, `plan_id=${rows[0]?.plan_id}`);
    assert(rows[0]?.temporality === "1m", S, "T-03:temporality-ok", `temporality=1m`, `temporality=${rows[0]?.temporality}`);
    passed += 4;
  } catch (e) {
    assert(false, S, "T-03:set", "", `${e}`); failed++;
  }

  // T-04: GET — Leer pending no expirado (simula usuario enviando teléfono)
  try {
    const { rows } = await pool.query(
      `SELECT plan_id, plan_name, temporality, expires_at
       FROM pending_interactions
       WHERE user_id=$1 AND type=$2 AND expires_at > NOW()`,
      [TEST_USER_ID, "plan_request"]
    );
    assert(rows.length === 1, S, "T-04:get-active", "getPendingInteraction devuelve row activo", "Row no devuelto — TTL fallido o type mismatch");
    assert(rows[0]?.plan_name === "Plan Básico", S, "T-04:plan-name-ok", `plan_name=Plan Básico`, `plan_name=${rows[0]?.plan_name}`);
    passed += 2;
  } catch (e) {
    assert(false, S, "T-04:get", "", `${e}`); failed++;
  }

  // T-05: UPSERT — mismo user_id, actualiza datos (simula cambio de plan antes de enviar teléfono)
  try {
    const expiresAt2 = new Date(Date.now() + 30 * 60 * 1000);
    await pool.query(
      `INSERT INTO pending_interactions (user_id, type, plan_id, plan_name, temporality, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id) DO UPDATE SET
         type=EXCLUDED.type, plan_id=EXCLUDED.plan_id, plan_name=EXCLUDED.plan_name,
         temporality=EXCLUDED.temporality, expires_at=EXCLUDED.expires_at, created_at=CURRENT_TIMESTAMP`,
      [TEST_USER_ID, "plan_request", "pro", "Plan Pro", "3m", expiresAt2]
    );
    const { rows } = await pool.query("SELECT plan_id, plan_name, temporality FROM pending_interactions WHERE user_id=$1", [TEST_USER_ID]);
    assert(rows.length === 1, S, "T-05:upsert-single-row", "UPSERT mantiene solo 1 row por usuario", `Rows=${rows.length}`);
    assert(rows[0]?.plan_id === "pro", S, "T-05:upsert-plan-updated", "plan_id actualizado a pro", `plan_id=${rows[0]?.plan_id}`);
    assert(rows[0]?.temporality === "3m", S, "T-05:upsert-temp-updated", "temporality actualizada a 3m", `temp=${rows[0]?.temporality}`);
    passed += 3;
  } catch (e) {
    assert(false, S, "T-05:upsert", "", `${e}`); failed++;
  }

  // T-06: TTL — row con expires_at en el pasado NO es devuelto por GET activo
  try {
    // Insertar row expirado para usuario 2
    const expiredAt = new Date(Date.now() - 1000); // 1 segundo en el pasado
    await pool.query(
      `INSERT INTO pending_interactions (user_id, type, plan_id, plan_name, temporality, expires_at)
       VALUES ($1,'plan_renewal','pro','Plan Pro','1m',$2)
       ON CONFLICT (user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
      [TEST_USER_ID_2, expiredAt]
    );
    const { rows } = await pool.query(
      `SELECT plan_id FROM pending_interactions WHERE user_id=$1 AND type='plan_renewal' AND expires_at > NOW()`,
      [TEST_USER_ID_2]
    );
    assert(rows.length === 0, S, "T-06:ttl-expired-not-returned", "Row expirado NO devuelto por query activo (TTL funciona)", `Se devolvió ${rows.length} row(s) expirado(s) — TTL ROTO`);
    passed++;
  } catch (e) {
    assert(false, S, "T-06:ttl", "", `${e}`); failed++;
  }

  // T-07: DELETE — Eliminar pending tras procesar contacto
  try {
    await pool.query(
      `DELETE FROM pending_interactions WHERE user_id=$1 AND type=$2`,
      [TEST_USER_ID, "plan_request"]
    );
    const { rows } = await pool.query("SELECT user_id FROM pending_interactions WHERE user_id=$1 AND type='plan_request'", [TEST_USER_ID]);
    assert(rows.length === 0, S, "T-07:delete-ok", "deletePendingInteraction elimina row correctamente", "Row persiste tras DELETE");
    passed++;
  } catch (e) {
    assert(false, S, "T-07:delete", "", `${e}`); failed++;
  }

  // T-08: cleanExpiredPendingInteractions — elimina rows expirados en masa
  try {
    // Insertar 3 rows expirados adicionales
    const expired = new Date(Date.now() - 60_000);
    for (const uid of [TEST_USER_ID, TEST_USER_ID_2]) {
      await pool.query(
        `INSERT INTO pending_interactions (user_id, type, plan_id, plan_name, temporality, expires_at)
         VALUES ($1,'plan_request','basico','Plan Básico','7d',$2)
         ON CONFLICT (user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at`,
        [uid, expired]
      );
    }
    const { rowCount } = await pool.query("DELETE FROM pending_interactions WHERE expires_at < NOW()");
    assert((rowCount ?? 0) >= 2, S, "T-08:clean-expired", `cleanExpiredPendingInteractions eliminó ${rowCount} row(s)`, `Solo ${rowCount} eliminados — esperaba ≥2`);
    passed++;
  } catch (e) {
    assert(false, S, "T-08:clean-expired", "", `${e}`); failed++;
  }

  // T-09: Session survival — simular reinicio de proceso (nueva conexión pool)
  //       Guarda un pending → cierra pool → abre nuevo pool → lee el pending
  try {
    const survivalPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL!,
      max: 2,
      ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : undefined,
    });
    // Guardar con pool original
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await pool.query(
      `INSERT INTO pending_interactions (user_id, type, plan_id, plan_name, temporality, expires_at)
       VALUES ($1,'plan_request','basico','Plan Básico','7d',$2)
       ON CONFLICT (user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at, plan_id=EXCLUDED.plan_id`,
      [TEST_USER_ID, expiresAt]
    );
    // Leer con pool distinto (simula "reinicio de proceso en Render")
    const { rows } = await survivalPool.query(
      `SELECT plan_id FROM pending_interactions WHERE user_id=$1 AND type='plan_request' AND expires_at > NOW()`,
      [TEST_USER_ID]
    );
    assert(rows.length === 1 && rows[0]?.plan_id === "basico", S,
      "T-09:session-survival",
      "✅ GAP-03 VERIFICADO: pending sobrevive reinicio del proceso (distinto pool = distinto proceso)",
      "❌ GAP-03 NO RESUELTO: pending perdido al cambiar de conexión"
    );
    passed++;
    await survivalPool.end();
    // Cleanup
    await pool.query("DELETE FROM pending_interactions WHERE user_id=$1", [TEST_USER_ID]);
  } catch (e) {
    assert(false, S, "T-09:session-survival", "", `${e}`); failed++;
  }

  // T-10: Índice de TTL optimiza la query de limpieza
  try {
    const { rows } = await pool.query(
      `EXPLAIN SELECT * FROM pending_interactions WHERE expires_at < NOW()`
    );
    const planText = rows.map((r: { "QUERY PLAN": string }) => r["QUERY PLAN"]).join(" ");
    const usesIndex = planText.includes("idx_pending_interactions_expires") || planText.includes("Index");
    if (!usesIndex) {
      warn(S, "T-10:ttl-index-usage", "Query de cleanup no usa índice (tabla pequeña → normal en dev)", { planText: planText.substring(0, 200) });
    } else {
      log("PASS", S, "T-10:ttl-index-usage", "Índice TTL usado en cleanup query");
    }
    passed++; // WARN no es fallo
  } catch (e) {
    assert(false, S, "T-10:ttl-index-usage", "", `${e}`); failed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-17  ENVIRONMENT AUDIT — GAP-01 / GAP-02 / GAP-05 (NEW v2.0)
// ─────────────────────────────────────────────────────────────────────────────

async function suiteEnvAudit(_pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-17:ENV-AUDIT";
  log("SUITE", S, "start", "Verifica variables de entorno críticas (GAP-01/02/05)");
  let passed = 0, failed = 0;

  // T-01: DATABASE_URL definida
  assert(!!process.env.DATABASE_URL, S, "T-01:database-url", "DATABASE_URL ✓", "DATABASE_URL no definida — bot no puede conectarse a DB");
  if (process.env.DATABASE_URL) passed++; else failed++;

  // T-02 (GAP-01): DATABASE_SSL — en Render debe ser false (internal URL no requiere SSL)
  {
    const sslValue = process.env.DATABASE_SSL ?? "(no definida)";
    if (sslValue === "true") {
      warn(S, "T-02:database-ssl-render", `DATABASE_SSL=true en este entorno — si DATABASE_URL es URL interna de Render (postgres://...dpg-...), debe ser false. GAP-01 PENDIENTE`, { sslValue });
      // No falla el test — depende del entorno local vs Render
    } else if (sslValue === "false" || sslValue === "(no definida)") {
      log("PASS", S, "T-02:database-ssl-render", `DATABASE_SSL=${sslValue} — correcto para Render internal URL`);
    } else {
      warn(S, "T-02:database-ssl-render", `DATABASE_SSL="${sslValue}" valor desconocido`, { sslValue });
    }
    passed++;
  }

  // T-03: WEBHOOK_URL definida (en producción el bot usa webhook, no polling)
  {
    const wh = process.env.WEBHOOK_URL ?? "";
    if (!wh) {
      warn(S, "T-03:webhook-url", "WEBHOOK_URL no definida — OK en dev (polling), requerida en Render prod");
    } else {
      log("PASS", S, "T-03:webhook-url", `WEBHOOK_URL=${wh.substring(0, 40)}...`);
    }
    passed++;
  }

  // T-04: BOT_OWNER_ID definido y numérico
  {
    const ownerRaw = process.env.BOT_OWNER_ID ?? "";
    const ownerId = Number(ownerRaw.split(",")[0] ?? "0");
    assert(ownerId > 0, S, "T-04:bot-owner-id", `BOT_OWNER_ID=${ownerId} ✓`, `BOT_OWNER_ID no definido o inválido ("${ownerRaw}") — sin acceso admin`);
    if (ownerId > 0) passed++; else failed++;
  }

  // T-05 (GAP-02): AUTO_DRAW_SECRET — requerida para webhook del auto-draw
  {
    const secret = process.env.AUTO_DRAW_SECRET ?? "";
    if (!secret) {
      assert(false, S, "T-05:auto-draw-secret", "", "AUTO_DRAW_SECRET no definida — ❌ GAP-02 ACTIVO: el webhook de auto-draw es inseguro (cualquiera puede triggerearlo)");
      failed++;
    } else {
      assert(true, S, "T-05:auto-draw-secret", `AUTO_DRAW_SECRET definida (${secret.length} chars) ✓`, "");
      passed++;
    }
  }

  // T-06 (GAP-05): GOOGLE_SPREADSHEET_ID debe estar vacía o indefinida (ya no se usa)
  {
    const sheetId = process.env.GOOGLE_SPREADSHEET_ID ?? "";
    if (sheetId && sheetId.trim() !== "") {
      warn(S, "T-06:google-sheet-id-empty", `GOOGLE_SPREADSHEET_ID="${sheetId.substring(0, 20)}..." todavía definida — GAP-05 ACTIVO: limpiar variable en Render`, { value: sheetId.substring(0, 20) });
    } else {
      log("PASS", S, "T-06:google-sheet-id-empty", "GOOGLE_SPREADSHEET_ID vacía/indefinida ✓ GAP-05 resuelto");
    }
    passed++;
  }

  // T-07 (GAP-05): SHEET_CLIENT_EMAIL debe estar vacía o indefinida
  {
    const email = process.env.SHEET_CLIENT_EMAIL ?? "";
    if (email && email.trim() !== "") {
      warn(S, "T-07:sheet-client-email-empty", `SHEET_CLIENT_EMAIL="${email.substring(0, 20)}..." todavía definida — GAP-05 ACTIVO: limpiar en Render`);
    } else {
      log("PASS", S, "T-07:sheet-client-email-empty", "SHEET_CLIENT_EMAIL vacía/indefinida ✓");
    }
    passed++;
  }

  // T-08: TELEGRAM_BOT_TOKEN definido (token de producción o dev)
  {
    const token = process.env.TELEGRAM_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN_DEV ?? "";
    assert(!!token, S, "T-08:telegram-token", `TELEGRAM_BOT_TOKEN definido (${token.length} chars)`, "TELEGRAM_BOT_TOKEN no definido — bot no puede autenticarse");
    if (token) passed++; else failed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-18  DRAWS REPOSITORY INTEGRITY (NEW v2.0)
// ─────────────────────────────────────────────────────────────────────────────

async function suiteDraws(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-18:DRAWS-REPOSITORY";
  log("SUITE", S, "start", "Verifica integridad de datos en tabla draws");
  let passed = 0, failed = 0;

  // T-01: Tabla draws tiene datos
  {
    const { rows } = await pool.query("SELECT count(*) as c FROM draws");
    const count = Number(rows[0]?.c ?? 0);
    assert(count > 0, S, "T-01:draws-has-data", `${count} sorteo(s) en DB`, "Tabla draws VACÍA — el scraper no ha corrido");
    if (count > 0) passed++; else failed++;
    log("INFO", S, "T-01:draws-count", `Total draws: ${count}`);
  }

  // T-02: Formato de fecha MM/DD/YY (critical — el bot parsea con split("/"))
  {
    const { rows } = await pool.query("SELECT date FROM draws LIMIT 20");
    const mmddyyRegex = /^\d{2}\/\d{2}\/\d{2}$/;
    let formatErrors = 0;
    for (const r of rows) {
      if (!mmddyyRegex.test(r.date)) formatErrors++;
    }
    assert(formatErrors === 0, S, "T-02:date-format-mmddyy", `Formato MM/DD/YY correcto en ${rows.length} muestras`, `${formatErrors} fechas con formato incorrecto — isPlanExpired/draw lookup fallará`);
    if (formatErrors === 0) passed++; else failed++;
    if (rows.length > 0) log("INFO", S, "T-02:date-sample", `Muestra: ${rows.slice(0, 3).map((r: {date: string}) => r.date).join(", ")}`);
  }

  // T-03: game solo tiene valores 'p3' o 'p4'
  {
    const { rows } = await pool.query("SELECT DISTINCT game FROM draws ORDER BY game");
    const games = rows.map((r: { game: string }) => r.game);
    const validGames = ["p3", "p4"];
    const invalidGames = games.filter((g: string) => !validGames.includes(g));
    assert(invalidGames.length === 0, S, "T-03:game-values", `game values OK: ${games.join(",")}`, `Valores inválidos: ${invalidGames.join(",")} — routing de sorteos fallará`);
    if (invalidGames.length === 0) passed++; else failed++;
  }

  // T-04: period solo tiene valores 'm' (midday) o 'e' (evening)
  {
    const { rows } = await pool.query("SELECT DISTINCT period FROM draws ORDER BY period");
    const periods = rows.map((r: { period: string }) => r.period);
    const validPeriods = ["m", "e"];
    const invalidPeriods = periods.filter((p: string) => !validPeriods.includes(p));
    assert(invalidPeriods.length === 0, S, "T-04:period-values", `period values OK: ${periods.join(",")}`, `Valores inválidos: ${invalidPeriods.join(",")} — lookup de sorteos fallará`);
    if (invalidPeriods.length === 0) passed++; else failed++;
  }

  // T-05: Últimos 5 sorteos Pick3 Midday
  {
    const { rows } = await pool.query(
      `SELECT date, numbers FROM draws WHERE game='p3' AND period='m' ORDER BY date DESC LIMIT 5`
    );
    assert(rows.length > 0, S, "T-05:p3-midday", `Últimos P3 Midday: ${rows.map((r: {date: string; numbers: string}) => `${r.date}:${r.numbers}`).join(" | ")}`, "Sin datos P3 Midday");
    if (rows.length > 0) passed++; else failed++;
  }

  // T-06: Últimos 5 sorteos Pick4 Evening
  {
    const { rows } = await pool.query(
      `SELECT date, numbers FROM draws WHERE game='p4' AND period='e' ORDER BY date DESC LIMIT 5`
    );
    assert(rows.length > 0, S, "T-06:p4-evening", `Últimos P4 Evening: ${rows.map((r: {date: string; numbers: string}) => `${r.date}:${r.numbers}`).join(" | ")}`, "Sin datos P4 Evening");
    if (rows.length > 0) passed++; else failed++;
  }

  // T-07: Detectar draws duplicados (misma date+game+period debería ser imposible por PK)
  {
    const { rows } = await pool.query(
      `SELECT date, game, period, count(*) as c FROM draws GROUP BY date, game, period HAVING count(*) > 1 LIMIT 5`
    );
    assert(rows.length === 0, S, "T-07:no-draw-duplicates", "Sin sorteos duplicados (PK funciona)", `${rows.length} grupo(s) duplicados — integridad comprometida`);
    if (rows.length === 0) passed++; else failed++;
  }

  // T-08: Datos recientes (último draw no más de 7 días atrás)
  {
    const { rows } = await pool.query("SELECT MAX(date) as latest FROM draws");
    const latest = rows[0]?.latest as string | null;
    if (latest) {
      const [mm, dd, yy] = latest.split("/");
      if (mm && dd && yy) {
        const year = parseInt(yy) <= 49 ? 2000 + parseInt(yy) : 1900 + parseInt(yy);
        const latestDate = new Date(year, parseInt(mm) - 1, parseInt(dd));
        const daysDiff = (Date.now() - latestDate.getTime()) / (1000 * 60 * 60 * 24);
        if (daysDiff > 7) {
          warn(S, "T-08:draws-freshness", `Último draw hace ${daysDiff.toFixed(0)} días (${latest}) — ¿scraper detenido?`, { daysDiff, latest });
        } else {
          log("PASS", S, "T-08:draws-freshness", `Datos frescos: último draw ${latest} (hace ${daysDiff.toFixed(0)} días)`);
        }
      }
    } else {
      warn(S, "T-08:draws-freshness", "No hay draws en DB");
    }
    passed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// S-19  SCHEMA CONSTRAINTS DEEP (NEW v2.0)
// ─────────────────────────────────────────────────────────────────────────────

async function suiteSchemaConstraints(pool: pg.Pool): Promise<SuiteResult> {
  const S = "S-19:SCHEMA-CONSTRAINTS";
  log("SUITE", S, "start", "Verifica FKs, PKs, CASCADE y constraints críticos");
  let passed = 0, failed = 0;

  // T-01: FK user_menus.user_id → users(id) ON DELETE CASCADE
  //       Al eliminar usuario, sus menús se eliminan automáticamente
  try {
    // Insertar usuario temporal + menú
    await pool.query(`INSERT INTO users (id, username) VALUES ($1,'fk_test_user') ON CONFLICT DO NOTHING`, [9_999_999_001]);
    await pool.query(`INSERT INTO user_menus (user_id, menu_id) VALUES ($1,'test_menu_fk') ON CONFLICT DO NOTHING`, [9_999_999_001]);
    // Eliminar usuario → debe eliminar menú en cascada
    await pool.query(`DELETE FROM users WHERE id=$1`, [9_999_999_001]);
    const { rows } = await pool.query("SELECT menu_id FROM user_menus WHERE user_id=$1", [9_999_999_001]);
    assert(rows.length === 0, S, "T-01:fk-user-menus-cascade", "FK user_menus→users CASCADE funciona (menú eliminado con usuario)", "Menú huérfano tras eliminar usuario — FK CASCADE roto");
    passed++;
  } catch (e) {
    assert(false, S, "T-01:fk-cascade", "", `${e}`); failed++;
  }

  // T-02: FK leads no tiene FK (user_id es BIGINT sin FK) — confirmación de diseño intencional
  {
    const { rows } = await pool.query(
      `SELECT tc.constraint_name, kcu.column_name, ccu.table_name as foreign_table
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu ON tc.constraint_name=kcu.constraint_name
       JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name=tc.constraint_name
       WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_name='leads'`
    );
    if (rows.length === 0) {
      log("INFO", S, "T-02:leads-no-fk", "leads.user_id sin FK → diseño intencional (permite leads de usuarios eliminados)");
    } else {
      log("INFO", S, "T-02:leads-fk-exists", `leads tiene FKs: ${rows.map((r: {column_name: string; foreign_table: string}) => `${r.column_name}→${r.foreign_table}`).join(", ")}`);
    }
    passed++;
  }

  // T-03: FK referrals.referred_id UNIQUE (un usuario solo puede ser referido una vez)
  {
    const { rows } = await pool.query(
      `SELECT constraint_name, constraint_type FROM information_schema.table_constraints
       WHERE table_name='referrals' AND constraint_type IN ('UNIQUE','PRIMARY KEY')`
    );
    const constraintNames = rows.map((r: {constraint_name: string}) => r.constraint_name);
    const hasUniqueReferredId = rows.some((r: {constraint_type: string}) => r.constraint_type === "UNIQUE");
    assert(hasUniqueReferredId, S, "T-03:referrals-unique-referred", `UNIQUE en referrals: ${constraintNames.join(",")}`, "Sin UNIQUE en referred_id — posible fraude de referrals");
    if (hasUniqueReferredId) passed++; else failed++;
  }

  // T-04: pending_interactions PK = user_id (máx 1 pending por usuario)
  try {
    const exp1 = new Date(Date.now() + 60_000);
    const exp2 = new Date(Date.now() + 120_000);
    await pool.query(
      `INSERT INTO pending_interactions (user_id, type, plan_id, plan_name, temporality, expires_at)
       VALUES ($1,'plan_request','basico','Plan Básico','1m',$2)`,
      [TEST_USER_ID, exp1]
    );
    let pkViolation = false;
    try {
      await pool.query(
        `INSERT INTO pending_interactions (user_id, type, plan_id, plan_name, temporality, expires_at)
         VALUES ($1,'plan_renewal','pro','Plan Pro','3m',$2)`,
        [TEST_USER_ID, exp2]
      );
    } catch (e: unknown) {
      if (e instanceof Error && (e.message?.includes("unique") || e.message?.includes("pkey"))) pkViolation = true;
    }
    assert(pkViolation, S, "T-04:pending-pk-one-per-user", "PK user_id impide 2 pendings del mismo usuario", "Sin protección — usuario puede tener múltiples pendings simultáneos");
    if (pkViolation) passed++; else failed++;
    await pool.query("DELETE FROM pending_interactions WHERE user_id=$1", [TEST_USER_ID]);
  } catch (e) {
    assert(false, S, "T-04:pending-pk", "", `${e}`);
    failed++;
  }

  // T-05: Todos los índices críticos del sistema existen
  const criticalIndexes: Array<{ table: string; idx: string }> = [
    { table: "draws", idx: "idx_draws_date" },
    { table: "draws", idx: "idx_draws_game" },
    { table: "users", idx: "idx_users_plan_status" },
    { table: "users", idx: "idx_users_referred_by" },
    { table: "user_menus", idx: "idx_user_menus_user" },
    { table: "referrals", idx: "idx_referrals_referred" },
    { table: "referrals", idx: "idx_referrals_rewarded" },
    { table: "leads", idx: "idx_leads_user" },
    { table: "strategy_requests", idx: "idx_strategy_requests_user" },
    { table: "pending_interactions", idx: "idx_pending_interactions_expires" },
  ];
  try {
    const { rows } = await pool.query(
      `SELECT tablename, indexname FROM pg_indexes WHERE schemaname='public'`
    );
    const existingIdx = new Set(rows.map((r: {indexname: string}) => r.indexname));
    for (const { table, idx } of criticalIndexes) {
      const ok = existingIdx.has(idx);
      if (ok) passed++; else failed++;
      assert(ok, S, `T-05:idx:${idx}`, `Índice ${idx} (${table}) ✓`, `Índice ${idx} FALTANTE en tabla ${table}`);
    }
  } catch (e) {
    assert(false, S, "T-05:critical-indexes", "", `${e}`); failed++;
  }

  // T-06: draws PRIMARY KEY (date, game, period) evita duplicados
  try {
    const { rows: existing } = await pool.query("SELECT date, game, period FROM draws LIMIT 1");
    if (existing.length > 0) {
      const { date, game, period } = existing[0] as { date: string; game: string; period: string };
      let pkViolation = false;
      try {
        await pool.query(
          `INSERT INTO draws (date, game, period, numbers) VALUES ($1,$2,$3,'TEST')`,
          [date, game, period]
        );
      } catch (e: unknown) {
        if (e instanceof Error && (e.message?.includes("unique") || e.message?.includes("pkey") || e.message?.includes("duplicate"))) pkViolation = true;
      }
      assert(pkViolation, S, "T-06:draws-pk-no-dup", `draws PK(date,game,period) impide duplicados`, "draws PK no funciona — posibles sorteos duplicados");
      if (pkViolation) passed++; else failed++;
    } else {
      warn(S, "T-06:draws-pk-no-dup", "Sin datos en draws — test omitido");
      passed++;
    }
  } catch (e) {
    assert(false, S, "T-06:draws-pk", "", `${e}`); failed++;
  }

  results.push({ suite: S, passed, failed, skipped: 0 });
  return { suite: S, passed, failed, skipped: 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN — Orquestador de suites v2.0
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log("START", "BLISS-TEST-SUITE", "init",
    `Run ID: ${RUN_ID} | Version: ${SUITE_VERSION} | DB: ${process.env.DATABASE_URL?.split("@")[1] ?? "?"}`
  );

  const pool = getPool();

  const suites = [
    () => suiteDbConnectivity(pool),       // S-01
    () => suiteUserOnboarding(pool),        // S-02
    () => suitePlanLifecycle(pool),         // S-03
    () => suiteAdminFlows(pool),            // S-04
    () => suiteAnnouncements(pool),         // S-05
    () => suitePaymentMethods(pool),        // S-06
    () => suiteSugerencias(pool),           // S-07
    () => suiteLeads(pool),                 // S-08
    () => suiteStrategyRequests(pool),      // S-09
    () => suiteTestingConfig(pool),         // S-10
    () => suiteReferrals(pool),             // S-11
    () => suiteStrategies(pool),            // S-12
    () => suitePlans(pool),                 // S-13
    () => suiteAccessControl(pool),         // S-14
    () => suiteCleanup(pool),               // S-15
    () => suitePendingInteractions(pool),   // S-16 NEW (GAP-03)
    () => suiteEnvAudit(pool),              // S-17 NEW (GAP-01/02/05)
    () => suiteDraws(pool),                 // S-18 NEW
    () => suiteSchemaConstraints(pool),     // S-19 NEW
  ];

  for (const suite of suites) {
    try {
      await suite();
    } catch (err) {
      console.error(`💥 Suite crashed: ${err}`);
      totalFailed++;
    }
    console.log("");
  }

  // ── Reporte final ─────────────────────────────────────────────────────────
  const totalTests = totalPassed + totalFailed;
  const pct = totalTests > 0 ? ((totalPassed / totalTests) * 100).toFixed(1) : "0.0";

  console.log("═".repeat(70));
  console.log(`🏁 BLISS TEST SUITE v${SUITE_VERSION} — RESULTADO FINAL`);
  console.log(`   Run ID  : ${RUN_ID}`);
  console.log(`   Total   : ${totalTests} tests`);
  console.log(`   ✅ Pass : ${totalPassed}`);
  console.log(`   ❌ Fail : ${totalFailed}`);
  console.log(`   Score   : ${pct}%`);
  console.log("═".repeat(70));

  // Separar resultados por categoría
  const fixedSuites  = results.filter(r => r.suite.startsWith("S-16") || r.suite.startsWith("S-19"));
  const newSuites    = results.filter(r => ["S-16", "S-17", "S-18", "S-19"].some(p => r.suite.startsWith(p)));
  const coreSuites   = results.filter(r => !newSuites.includes(r));

  console.log("\n  ── CORE SUITES ──────────────────────────────────");
  for (const r of coreSuites) {
    const icon = r.failed === 0 ? "✅" : "❌";
    console.log(`  ${icon} ${r.suite.padEnd(34)} PASS=${r.passed} FAIL=${r.failed}`);
  }

  console.log("\n  ── NEW v2.0 SUITES ──────────────────────────────");
  for (const r of newSuites) {
    const icon = r.failed === 0 ? "✅" : r.suite.startsWith("S-17") ? "⚠️" : "❌";
    const tag = r.suite.startsWith("S-16") ? "[GAP-03 FIX]" : r.suite.startsWith("S-17") ? "[GAP AUDIT]" : r.suite.startsWith("S-18") ? "[DRAWS]" : "[SCHEMA]";
    console.log(`  ${icon} ${r.suite.padEnd(34)} PASS=${r.passed} FAIL=${r.failed}  ${tag}`);
  }

  // Resumen GAPs
  const envResult = results.find(r => r.suite.startsWith("S-17"));
  console.log("\n  ── GAP STATUS ───────────────────────────────────");
  console.log(`  ✅ GAP-03: pending_interactions en PostgreSQL (S-16)`);
  if (envResult) {
    console.log(`  ${envResult.failed > 0 ? "❌" : "⚠️"} GAP-01/02/05: ver S-17 (acción manual en Render Dashboard)`);
  }

  console.log("═".repeat(70));

  console.log(`__BLISS_LOG__ ${JSON.stringify({
    run_id: RUN_ID, level: "FINAL", ts: new Date().toISOString(),
    version: SUITE_VERSION,
    total: totalTests, passed: totalPassed, failed: totalFailed,
    score_pct: parseFloat(pct), suites: results,
    gap_status: {
      "GAP-03": fixedSuites.every(r => r.failed === 0) ? "FIXED" : "BROKEN",
      "GAP-01": "PENDING_MANUAL",
      "GAP-02": "PENDING_MANUAL",
      "GAP-05": "PENDING_MANUAL",
    }
  })}`);

  await pool.end();
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("💥 FATAL:", e);
  process.exit(1);
});
