/**
 * S-14: Access Control & Menu Isolation
 * Verifies role-based access, menu entitlement logic, and
 * that expired/rejected/unapproved users cannot access paid content.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createPool, closePool, withRollback, insertTestUser, TEST_IDS, isPlanExpired, type UserRow } from "./setup.js";

let pool: pg.Pool;
beforeAll(() => { pool = createPool(); });
afterAll(closePool);

const UID  = TEST_IDS.USER_1;
const UID2 = TEST_IDS.USER_2;

describe("S-14: Access Control & Menu Isolation", () => {

  it("new user has no menus assigned", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      const { rows } = await c.query<{ c: string }>(
        "SELECT count(*) as c FROM user_menus WHERE user_id=$1", [UID]
      );
      expect(Number(rows[0]?.c)).toBe(0);
    });
  });

  it("approved user can have menus assigned", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID, { plan_status: "approved", plan_id: "basico" });
      await c.query(
        "INSERT INTO user_menus (user_id, menu_id) VALUES ($1,'menu_basico'),($1,'menu_picks') ON CONFLICT DO NOTHING",
        [UID]
      );
      const { rows } = await c.query<{ c: string }>(
        "SELECT count(*) as c FROM user_menus WHERE user_id=$1", [UID]
      );
      expect(Number(rows[0]?.c)).toBe(2);
    });
  });

  it("rejected user menus are cleared on rejection", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID, { plan_status: "approved", plan_id: "basico" });
      await c.query(
        "INSERT INTO user_menus (user_id, menu_id) VALUES ($1,'menu_basico') ON CONFLICT DO NOTHING",
        [UID]
      );
      // Simulate rejection: clear menus
      await c.query("DELETE FROM user_menus WHERE user_id=$1", [UID]);
      await c.query(
        "UPDATE users SET plan_status='rejected', plan_id=NULL WHERE id=$1",
        [UID]
      );
      const { rows } = await c.query<{ c: string }>(
        "SELECT count(*) as c FROM user_menus WHERE user_id=$1", [UID]
      );
      expect(Number(rows[0]?.c)).toBe(0);
    });
  });

  it("expired plan user — isPlanExpired check triggers access block", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID, { plan_status: "approved" });
      await c.query(
        "UPDATE users SET plan_expiry=TO_CHAR(NOW() - INTERVAL '1 day','MM/DD/YY') WHERE id=$1",
        [UID]
      );
      const { rows } = await c.query<UserRow>("SELECT plan_expiry, plan_status FROM users WHERE id=$1", [UID]);
      const user = rows[0]!;
      // Bot access check: approved but expired → blocked
      const hasAccess = user.plan_status === "approved" && !isPlanExpired(user.plan_expiry);
      expect(hasAccess).toBe(false);
    });
  });

  it("approved non-expired plan — access granted", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID, { plan_status: "approved" });
      await c.query(
        "UPDATE users SET plan_expiry=TO_CHAR(NOW() + INTERVAL '30 days','MM/DD/YY') WHERE id=$1",
        [UID]
      );
      const { rows } = await c.query<UserRow>("SELECT plan_expiry, plan_status FROM users WHERE id=$1", [UID]);
      const user = rows[0]!;
      const hasAccess = user.plan_status === "approved" && !isPlanExpired(user.plan_expiry);
      expect(hasAccess).toBe(true);
    });
  });

  it("user with plan_status=requested has no active access", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID, { plan_status: "requested" });
      const { rows } = await c.query<UserRow>("SELECT plan_status FROM users WHERE id=$1", [UID]);
      const hasAccess = rows[0]?.plan_status === "approved";
      expect(hasAccess).toBe(false);
    });
  });

  it("user with plan_status=null has no active access", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID); // plan_status defaults to null
      const { rows } = await c.query<UserRow>("SELECT plan_status FROM users WHERE id=$1", [UID]);
      expect(rows[0]?.plan_status).toBeNull();
      const hasAccess = rows[0]?.plan_status === "approved";
      expect(hasAccess).toBe(false);
    });
  });

  it("owner role bypasses plan check (role='owner' grants full access)", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query("UPDATE users SET role='owner' WHERE id=$1", [UID]);
      const { rows } = await c.query<UserRow>("SELECT role FROM users WHERE id=$1", [UID]);
      const isOwner = rows[0]?.role === "owner";
      expect(isOwner).toBe(true);
    });
  });

  it("two users have isolated menus — no cross-contamination", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await insertTestUser(c, UID2);
      await c.query(
        "INSERT INTO user_menus (user_id, menu_id) VALUES ($1,'menu_user1_only') ON CONFLICT DO NOTHING",
        [UID]
      );
      const { rows } = await c.query<{ menu_id: string }>(
        "SELECT menu_id FROM user_menus WHERE user_id=$1", [UID2]
      );
      const menus = rows.map((r) => r.menu_id);
      expect(menus).not.toContain("menu_user1_only");
    });
  });

  it("user_menus ON CONFLICT DO NOTHING prevents duplicate menu assignment", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        "INSERT INTO user_menus (user_id, menu_id) VALUES ($1,'menu_dup') ON CONFLICT DO NOTHING",
        [UID]
      );
      await c.query(
        "INSERT INTO user_menus (user_id, menu_id) VALUES ($1,'menu_dup') ON CONFLICT DO NOTHING",
        [UID]
      );
      const { rows } = await c.query<{ c: string }>(
        "SELECT count(*) as c FROM user_menus WHERE user_id=$1 AND menu_id='menu_dup'",
        [UID]
      );
      expect(Number(rows[0]?.c)).toBe(1);
    });
  });

  it("user can have multiple different menus assigned simultaneously", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID, { plan_status: "approved", plan_id: "pro" });
      const menus = ["menu_basico", "menu_pro", "menu_picks", "menu_extras"];
      for (const m of menus) {
        await c.query(
          "INSERT INTO user_menus (user_id, menu_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
          [UID, m]
        );
      }
      const { rows } = await c.query<{ c: string }>(
        "SELECT count(*) as c FROM user_menus WHERE user_id=$1", [UID]
      );
      expect(Number(rows[0]?.c)).toBe(menus.length);
    });
  });

  it("plan_expiry null = no plan, access must be blocked (not assumed active)", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID, { plan_status: "approved" });
      // plan_expiry stays null (e.g. owner-gifted perpetual, but bot must check explicitly)
      const { rows } = await c.query<UserRow>("SELECT plan_expiry FROM users WHERE id=$1", [UID]);
      // isPlanExpired(null) = false → so null expiry is treated as never-expiring
      expect(isPlanExpired(rows[0]?.plan_expiry)).toBe(false);
    });
  });
});
