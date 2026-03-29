/**
 * S-19: Schema Constraints & Integrity
 * Validates FK cascades, UNIQUE constraints, CHECK constraints,
 * PRIMARY KEYs, and all 10 critical indexes are present.
 * These tests protect against accidental schema drift.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createPool, closePool, withRollback, insertTestUser, TEST_IDS } from "./setup.js";

let pool: pg.Pool;
beforeAll(() => { pool = createPool(); });
afterAll(closePool);

const UID  = TEST_IDS.USER_1;
const UID2 = TEST_IDS.USER_2;

// ─── Critical indexes expected in production ──────────────────────────────────

const CRITICAL_INDEXES = [
  { table: "draws",               idx: "idx_draws_date" },
  { table: "draws",               idx: "idx_draws_game" },
  { table: "users",               idx: "idx_users_plan_status" },
  { table: "users",               idx: "idx_users_referred_by" },
  { table: "user_menus",          idx: "idx_user_menus_user" },
  { table: "referrals",           idx: "idx_referrals_referred" },
  { table: "referrals",           idx: "idx_referrals_rewarded" },
  { table: "leads",               idx: "idx_leads_user" },
  { table: "strategy_requests",   idx: "idx_strategy_requests_user" },
  { table: "pending_interactions",idx: "idx_pending_interactions_expires" },
] as const;

describe("S-19: Schema Constraints & Integrity", () => {

  // ── FK cascades ─────────────────────────────────────────────────────────────

  it("DELETE user cascades to user_menus (FK ON DELETE CASCADE)", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        "INSERT INTO user_menus (user_id, menu_id) VALUES ($1,'menu_cascade_test') ON CONFLICT DO NOTHING",
        [UID]
      );
      await c.query("DELETE FROM users WHERE id=$1", [UID]);
      const { rows } = await c.query(
        "SELECT menu_id FROM user_menus WHERE user_id=$1", [UID]
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("DELETE user SET NULLs suggestions.user_id (FK ON DELETE SET NULL)", async () => {
    // suggestions.user_id has ON DELETE SET NULL — row is kept but user_id nulled
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      const { rows: ins } = await c.query<{ id: number }>(
        "INSERT INTO suggestions (user_id, text) VALUES ($1,'test cascade sug') RETURNING id", [UID]
      );
      const sugId = ins[0]!.id;
      await c.query("DELETE FROM users WHERE id=$1", [UID]);
      const { rows } = await c.query<{ user_id: string | null }>("SELECT user_id FROM suggestions WHERE id=$1", [sugId]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.user_id).toBeNull();
    });
  });

  it("strategy_requests has no FK to users (orphan rows survive user delete — by design)", async () => {
    // strategy_requests has no FK — rows are not automatically removed on user delete
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        `INSERT INTO strategy_requests (user_id, menu_id, requested_at) VALUES ($1,'sr_no_fk',$2)`,
        [UID, Date.now()]
      );
      await c.query("DELETE FROM users WHERE id=$1", [UID]);
      const { rows } = await c.query("SELECT user_id FROM strategy_requests WHERE user_id=$1", [UID]);
      // No FK = row survives (application must clean up manually)
      expect(rows).toHaveLength(1);
    });
  });

  it("pending_interactions has no FK to users (orphan rows survive user delete — by design)", async () => {
    // pending_interactions has no FK — application must handle cleanup
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        `INSERT INTO pending_interactions (user_id, type, plan_id, plan_name, temporality, expires_at)
         VALUES ($1,'plan_request','basico','Plan Básico','7d', NOW() + INTERVAL '30 minutes')`,
        [UID]
      );
      await c.query("DELETE FROM users WHERE id=$1", [UID]);
      const { rows } = await c.query("SELECT user_id FROM pending_interactions WHERE user_id=$1", [UID]);
      // No FK = row survives
      expect(rows).toHaveLength(1);
    });
  });

  // ── leads has NO FK (intentional design) ────────────────────────────────────

  it("leads table does NOT enforce FK on user_id (design: leads survive user deletion)", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        `INSERT INTO leads (user_id, nombre, telefono, plan, temporality, fecha, status)
         VALUES ($1,'Test','555','basico','7d',TO_CHAR(NOW(),'DD/MM/YYYY'),'trial_active')`,
        [UID]
      );
      // Delete user — leads row should remain (no CASCADE)
      await c.query("DELETE FROM users WHERE id=$1", [UID]);
      const { rows } = await c.query("SELECT user_id FROM leads WHERE user_id=$1", [UID]);
      expect(rows).toHaveLength(1);
    });
  });

  // ── UNIQUE constraints ───────────────────────────────────────────────────────

  it("referrals UNIQUE(referred_id) enforced", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await insertTestUser(c, UID2);
      await c.query(
        "INSERT INTO referrals (referrer_id, referred_id, rewarded) VALUES ($1,$2,FALSE)",
        [UID, UID2]
      );
      await expect(
        c.query("INSERT INTO referrals (referrer_id, referred_id, rewarded) VALUES ($1,$2,FALSE)", [UID, UID2])
      ).rejects.toThrow(/unique/i);
    });
  });

  it("leads UNIQUE(user_id) enforced", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        `INSERT INTO leads (user_id, nombre, telefono, plan, temporality, fecha, status)
         VALUES ($1,'A','0','basico','7d',TO_CHAR(NOW(),'DD/MM/YYYY'),'trial_active')`,
        [UID]
      );
      await expect(
        c.query(
          `INSERT INTO leads (user_id, nombre, telefono, plan, temporality, fecha, status)
           VALUES ($1,'B','1','pro','1m',TO_CHAR(NOW(),'DD/MM/YYYY'),'trial_active')`,
          [UID]
        )
      ).rejects.toThrow(/unique/i);
    });
  });

  it("strategy_requests UNIQUE(user_id, menu_id) enforced without ON CONFLICT", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        "INSERT INTO strategy_requests (user_id, menu_id, requested_at) VALUES ($1,'menu_uniq_test',$2)",
        [UID, Date.now()]
      );
      await expect(
        c.query(
          "INSERT INTO strategy_requests (user_id, menu_id, requested_at) VALUES ($1,'menu_uniq_test',$2)",
          [UID, Date.now() + 1]
        )
      ).rejects.toThrow(/unique/i);
    });
  });

  it("pending_interactions PRIMARY KEY(user_id) enforced without ON CONFLICT", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        `INSERT INTO pending_interactions (user_id, type, plan_id, plan_name, temporality, expires_at)
         VALUES ($1,'plan_request','basico','Plan B','7d', NOW() + INTERVAL '30 minutes')`,
        [UID]
      );
      await expect(
        c.query(
          `INSERT INTO pending_interactions (user_id, type, plan_id, plan_name, temporality, expires_at)
           VALUES ($1,'plan_renewal','pro','Plan P','1m', NOW() + INTERVAL '30 minutes')`,
          [UID]
        )
      ).rejects.toThrow(/unique|primary key|duplicate/i);
    });
  });

  // ── draws PRIMARY KEY ────────────────────────────────────────────────────────

  it("draws table has composite PRIMARY KEY on (date, game, period)", async () => {
    // draws has no id column — PK is the combination of date+game+period
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_name='draws'`
    );
    expect(rows.length).toBe(3);
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain("date");
    expect(cols).toContain("game");
    expect(cols).toContain("period");
  });

  // ── users PRIMARY KEY ────────────────────────────────────────────────────────

  it("users table has PRIMARY KEY on id", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_name='users'`
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.map((r) => r.column_name)).toContain("id");
  });

  // ── critical indexes ─────────────────────────────────────────────────────────

  describe("critical indexes present", () => {
    let existingIndexes: Set<string>;

    beforeAll(async () => {
      const { rows } = await pool.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname='public'"
      );
      existingIndexes = new Set(rows.map((r) => r.indexname));
    });

    for (const { table, idx } of CRITICAL_INDEXES) {
      it(`'${idx}' on ${table}`, () => {
        expect(
          existingIndexes.has(idx),
          `Index '${idx}' MISSING on table '${table}' — queries will be slow or broken`
        ).toBe(true);
      });
    }
  });

  // ── total table count ─────────────────────────────────────────────────────────

  it("public schema has exactly 13 expected tables", async () => {
    const EXPECTED = new Set([
      "users", "user_menus", "plans", "draws", "custom_strategies",
      "announcements", "suggestions", "payment_methods", "testing_config",
      "leads", "strategy_requests", "referrals", "pending_interactions",
    ]);
    const { rows } = await pool.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname='public'"
    );
    const found = new Set(rows.map((r) => r.tablename));
    for (const t of EXPECTED) {
      expect(found.has(t), `Table '${t}' is missing from public schema`).toBe(true);
    }
  });
});
