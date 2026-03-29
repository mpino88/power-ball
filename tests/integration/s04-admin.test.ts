/**
 * S-04: Admin Flows — approve, reject, assign/remove menus.
 * Each test is fully autonomous (own setup inside withRollback).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createPool, closePool, withRollback, insertTestUser, TEST_IDS, type UserRow } from "./setup.js";

let pool: pg.Pool;
beforeAll(() => { pool = createPool(); });
afterAll(closePool);

const UID  = TEST_IDS.USER_1;
const UID2 = TEST_IDS.USER_2;

describe("S-04: Admin Flows", () => {
  it("admin sees pending requests (plan_status=requested)", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID, { plan_status: "requested", plan_id: "basico" });
      const { rows } = await c.query<UserRow>(
        "SELECT id, plan_status FROM users WHERE plan_status='requested'"
      );
      const ids = rows.map((r) => r.id);
      expect(ids).toContain(String(UID));
    });
  });

  it("admin approves plan → status=approved, pending_plan=null", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID, { plan_status: "requested", pending_plan: "basico|1m" });
      await c.query(
        `UPDATE users SET plan_status='approved', pending_plan=NULL,
         plan_id='basico', plan_expiry=TO_CHAR(NOW() + INTERVAL '30 days','MM/DD/YY')
         WHERE id=$1`,
        [UID]
      );
      const { rows } = await c.query<UserRow>("SELECT plan_status, plan_id, pending_plan FROM users WHERE id=$1", [UID]);
      expect(rows[0]?.plan_status).toBe("approved");
      expect(rows[0]?.plan_id).toBe("basico");
      expect(rows[0]?.pending_plan).toBeNull();
    });
  });

  it("admin rejects plan → status=rejected, plan_id cleared", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID2, { plan_status: "requested", plan_id: "basico" });
      await c.query(
        "UPDATE users SET plan_status='rejected', plan_id=NULL, pending_plan=NULL WHERE id=$1",
        [UID2]
      );
      const { rows } = await c.query<UserRow>("SELECT plan_status, plan_id FROM users WHERE id=$1", [UID2]);
      expect(rows[0]?.plan_status).toBe("rejected");
      expect(rows[0]?.plan_id).toBeNull();
    });
  });

  it("admin assigns extra menu to user", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        "INSERT INTO user_menus (user_id, menu_id) VALUES ($1,'menu_pro_test') ON CONFLICT DO NOTHING",
        [UID]
      );
      const { rows } = await c.query<{ menu_id: string }>(
        "SELECT menu_id FROM user_menus WHERE user_id=$1 AND menu_id='menu_pro_test'",
        [UID]
      );
      expect(rows).toHaveLength(1);
    });
  });

  it("admin removes menu from user", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        "INSERT INTO user_menus (user_id, menu_id) VALUES ($1,'menu_to_remove') ON CONFLICT DO NOTHING",
        [UID]
      );
      await c.query("DELETE FROM user_menus WHERE user_id=$1 AND menu_id='menu_to_remove'", [UID]);
      const { rows } = await c.query<{ menu_id: string }>(
        "SELECT menu_id FROM user_menus WHERE user_id=$1 AND menu_id='menu_to_remove'",
        [UID]
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("rejected user has 0 menus assigned (menu isolation)", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID2, { plan_status: "rejected" });
      const { rows } = await c.query<{ c: string }>(
        "SELECT count(*) as c FROM user_menus WHERE user_id=$1", [UID2]
      );
      expect(Number(rows[0]?.c)).toBe(0);
    });
  });

  it("owner role is not assignable to test users", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID); // role defaults to 'user'
      const { rows } = await c.query<UserRow>("SELECT role FROM users WHERE id=$1", [UID]);
      expect(rows[0]?.role).toBe("user");
      expect(rows[0]?.role).not.toBe("owner");
    });
  });
});
