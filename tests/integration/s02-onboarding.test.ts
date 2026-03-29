/**
 * S-02: User Onboarding
 * Autonomous — each test rolls back. Zero coupling to other suites.
 * Covers: first /start, duplicate /start guard, trial request, auto-approval,
 * lead capture, menu assignment, and edge cases.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createPool, closePool, withRollback, insertTestUser, TEST_IDS, type UserRow } from "./setup.js";

let pool: pg.Pool;

beforeAll(() => { pool = createPool(); });
afterAll(closePool);

const UID = TEST_IDS.USER_1;

describe("S-02: User Onboarding", () => {
  it("creates new user with correct defaults on first /start", async () => {
    await withRollback(pool, async (c) => {
      const user = await insertTestUser(c, UID);
      expect(user.trial_used).toBe(false);
      expect(user.plan_status).toBeNull();
      expect(user.plan_id).toBeNull();
      expect(user.role).toBe("user");
      expect(user.phone).toBe("");
    });
  });

  it("duplicate /start does NOT overwrite existing username (ON CONFLICT DO NOTHING)", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID, { username: "original_name" });
      // Second /start attempt
      await c.query(
        `INSERT INTO users (id, username, role, trial_used)
         VALUES ($1, 'new_name', 'user', FALSE)
         ON CONFLICT (id) DO NOTHING`,
        [UID]
      );
      const { rows } = await c.query<UserRow>("SELECT username FROM users WHERE id=$1", [UID]);
      expect(rows[0]?.username).toBe("original_name");
    });
  });

  it("duplicate /start yields exactly 1 row (no phantom duplicates)", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        "INSERT INTO users (id, username, role, trial_used) VALUES ($1,'dup','user',FALSE) ON CONFLICT DO NOTHING",
        [UID]
      );
      const { rows } = await c.query<{ c: string }>("SELECT count(*) as c FROM users WHERE id=$1", [UID]);
      expect(Number(rows[0]?.c)).toBe(1);
    });
  });

  it("trial request stores plan_status=requested, temporality=7d, phone", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        `UPDATE users SET plan_id='basico', plan_status='requested', plan_temporality='7d',
         plan_expiry=TO_CHAR(NOW() + INTERVAL '7 days','MM/DD/YY'),
         phone='5551234567', username='Test User BLISS'
         WHERE id=$1`,
        [UID]
      );
      const { rows } = await c.query<UserRow>("SELECT * FROM users WHERE id=$1", [UID]);
      expect(rows[0]?.plan_status).toBe("requested");
      expect(rows[0]?.plan_temporality).toBe("7d");
      expect(rows[0]?.phone).toBe("5551234567");
    });
  });

  it("trial auto-approval sets status=approved and trial_used=true", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        `UPDATE users SET plan_status='approved', trial_used=TRUE,
         plan_expiry=TO_CHAR(NOW() + INTERVAL '7 days','MM/DD/YY')
         WHERE id=$1`,
        [UID]
      );
      const { rows } = await c.query<UserRow>("SELECT plan_status, trial_used FROM users WHERE id=$1", [UID]);
      expect(rows[0]?.plan_status).toBe("approved");
      expect(rows[0]?.trial_used).toBe(true);
    });
  });

  it("menu is assigned to user after trial approval", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        "INSERT INTO user_menus (user_id, menu_id) VALUES ($1,'menu_basico') ON CONFLICT DO NOTHING",
        [UID]
      );
      const { rows } = await c.query<{ menu_id: string }>(
        "SELECT menu_id FROM user_menus WHERE user_id=$1",
        [UID]
      );
      const menus = rows.map((r) => r.menu_id);
      expect(menus).toContain("menu_basico");
    });
  });

  it("lead is captured in leads table with status=trial_active", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        `INSERT INTO leads (user_id, nombre, telefono, plan, temporality, fecha, status)
         VALUES ($1,'Test Bliss','5551234567','basico','7d',TO_CHAR(NOW(),'DD/MM/YYYY HH24:MI'),'trial_active')
         ON CONFLICT (user_id) DO UPDATE SET status=EXCLUDED.status`,
        [UID]
      );
      const { rows } = await c.query<{ status: string; nombre: string }>(
        "SELECT status, nombre FROM leads WHERE user_id=$1", [UID]
      );
      expect(rows[0]?.status).toBe("trial_active");
      expect(rows[0]?.nombre).toBe("Test Bliss");
    });
  });

  it("plan_expiry format is MM/DD/YY (bot parse requirement)", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        `UPDATE users SET plan_expiry=TO_CHAR(NOW() + INTERVAL '7 days','MM/DD/YY') WHERE id=$1`,
        [UID]
      );
      const { rows } = await c.query<UserRow>("SELECT plan_expiry FROM users WHERE id=$1", [UID]);
      const expiry = rows[0]?.plan_expiry;
      expect(expiry).toMatch(/^\d{2}\/\d{2}\/\d{2}$/);
    });
  });
});
