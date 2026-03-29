/**
 * tests/integration/setup.ts
 * ══════════════════════════════════════════════════════════════════════
 * Shared infrastructure for all integration tests.
 *
 * Exports:
 *   createPool()    — singleton Pool from DATABASE_URL
 *   withRollback()  — execute inside a tx that ALWAYS rolls back
 *   withCommit()    — execute inside a tx that commits (DDL audits)
 *   TEST_IDS        — runtime-unique user IDs (no parallel collision)
 *   isPlanExpired() — pure business logic, tested in unit suite
 *   parseMMDDYY()   — pure date parser, tested in unit suite
 *   blissLog()      — structured __BLISS_LOG__ output for Render Logs
 *   DB row types    — UserRow, DrawRow, LeadRow, PendingInteractionRow, …
 * ══════════════════════════════════════════════════════════════════════
 */

import pg from "pg";

// ── DB Row Types ────────────────────────────────────────────────────────────

export interface UserRow {
  id: string;           // bigint → string in node-postgres
  username: string | null;
  phone: string | null;
  role: string;
  plan_id: string | null;
  plan_status: string | null;
  pending_plan: string | null;
  plan_temporality: string | null;
  plan_expiry: string | null;  // format: MM/DD/YY
  trial_used: boolean;
  referred_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface DrawRow {
  date: string;     // MM/DD/YY
  game: "p3" | "p4";
  period: "m" | "e";
  numbers: string;  // CSV
  created_at: Date;
}

export interface LeadRow {
  id: number;
  user_id: string;
  nombre: string;
  telefono: string;
  plan: string;
  temporality: string;
  fecha: string;
  status: string;
  created_at: Date;
}

export interface PendingInteractionRow {
  user_id: string;
  type: "plan_request" | "plan_renewal";
  plan_id: string;
  plan_name: string;
  temporality: string;
  expires_at: Date;
  created_at: Date;
}

export interface ReferralRow {
  id: number;
  referrer_id: string;
  referred_id: string;
  rewarded: boolean;
  rewarded_at: Date | null;
  created_at: Date;
}

export interface AnnouncementRow {
  id: number;
  text: string;
  timestamp: string;
}

export interface PaymentMethodRow {
  id: number;
  name: string;
  details: string;
}

export interface SuggestionRow {
  id: number;
  user_id: string | null;
  text: string;
  nombre: string;
  telefono: string;
  fecha: string;
}

export interface PlanRow {
  id: string;
  title: string;
  description: string | null;
  price: string | null;
  auto_approve: boolean;
  price_1m: string | null;
  price_3m: string | null;
  price_6m: string | null;
  price_9m: string | null;
  price_1a: string | null;
}

export interface StrategyRow {
  id: string;
  titulo: string;
  descripcion: string | null;
  visibility: string;
  subscribers: number;
}

// ── Business Logic — pure functions (also exported for unit tests) ──────────

/**
 * Parses MM/DD/YY into a Date at 23:59:59 (end of that day).
 * Returns null if the input is null, undefined, or has an invalid format.
 */
export function parseMMDDYY(expiry: string | null | undefined): Date | null {
  if (!expiry) return null;
  const parts = expiry.split("/");
  if (parts.length !== 3) return null;
  const [mm, dd, yy] = parts;
  if (!mm || !dd || !yy) return null;
  const y = parseInt(yy, 10);
  const m = parseInt(mm, 10);
  const d = parseInt(dd, 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const year = y <= 49 ? 2000 + y : 1900 + y;
  return new Date(year, m - 1, d, 23, 59, 59);
}

/**
 * Returns true if the plan expiry date has passed.
 * null/undefined/invalid expiry → false (no plan = not expired).
 */
export function isPlanExpired(planExpiry: string | null | undefined): boolean {
  const exp = parseMMDDYY(planExpiry);
  return exp !== null && exp < new Date();
}

/**
 * Returns true if the user can request a trial plan.
 * Conditions: no active/approved plan AND trial not yet used.
 */
export function canRequestTrial(user: Pick<UserRow, "plan_status" | "trial_used">): boolean {
  return user.plan_status !== "approved" && user.trial_used !== true;
}

// ── Test ID Factory ─────────────────────────────────────────────────────────

/**
 * Runtime-unique IDs prevent collisions when two devs run tests in parallel.
 * Pattern: 9_000_000_000 + (last 5 digits of timestamp * 10) + slot
 * Never collides with real users (Telegram IDs are much smaller).
 */
const RUN_STAMP = Date.now() % 100_000; // 5 digits

export const TEST_IDS = {
  USER_1:  BigInt(9_000_000_000 + RUN_STAMP * 10 + 1),
  USER_2:  BigInt(9_000_000_000 + RUN_STAMP * 10 + 2),
  FK_USER: BigInt(9_000_000_000 + RUN_STAMP * 10 + 3),
} as const;

export type TestIdKey = keyof typeof TEST_IDS;

// ── Pool Factory ─────────────────────────────────────────────────────────────

let _pool: pg.Pool | null = null;

export function createPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL not set — add to .env or CI secrets");
  const useSSL = process.env.DATABASE_SSL === "true";
  _pool = new pg.Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 8_000,
    ssl: useSSL ? { rejectUnauthorized: false } : undefined,
  });
  return _pool;
}

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

// ── Transaction Helpers ──────────────────────────────────────────────────────

/**
 * Executes fn inside a transaction that is ALWAYS rolled back.
 * Guarantees the DB is clean after every test, even on assertion errors.
 *
 * Usage:
 *   await withRollback(pool, async (client) => {
 *     await client.query("INSERT INTO users ...", [...]);
 *     const { rows } = await client.query("SELECT ...", [...]);
 *     expect(rows[0].plan_status).toBe("approved");
 *   });
 */
export async function withRollback<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    return await fn(client);
  } finally {
    // Always rollback — even if fn threw
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    client.release();
  }
}

/**
 * Executes fn inside a transaction that commits on success.
 * Use for read-only queries that don't need isolation, or for
 * one-time setup operations (rare).
 */
export async function withCommit<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  await client.query("BEGIN");
  try {
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ── Query Helpers ────────────────────────────────────────────────────────────

/** Insert a test user, return the row. Meant for use inside withRollback. */
export async function insertTestUser(
  client: pg.PoolClient,
  id: bigint,
  overrides: Partial<Omit<UserRow, "id" | "created_at" | "updated_at">> = {},
): Promise<UserRow> {
  const {
    username = "test_bliss",
    phone = "",
    role = "user",
    plan_id = null,
    plan_status = null,
    trial_used = false,
  } = overrides;
  await client.query(
    `INSERT INTO users (id, username, phone, role, plan_id, plan_status, trial_used)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (id) DO NOTHING`,
    [id, username, phone, role, plan_id, plan_status, trial_used],
  );
  const { rows } = await client.query<UserRow>("SELECT * FROM users WHERE id=$1", [id]);
  if (!rows[0]) throw new Error(`insertTestUser: user ${id} not found after insert`);
  return rows[0];
}

// ── Render Forensics Logger ─────────────────────────────────────────────────

export function blissLog(data: Record<string, unknown>): void {
  console.log(`__BLISS_LOG__ ${JSON.stringify({ ts: new Date().toISOString(), ...data })}`);
}
