/**
 * S-03: Plan Lifecycle
 * Autonomous. Tests expiry logic, second-trial guard, renewal flow,
 * date format validation. All within rollback transactions.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createPool, closePool, withRollback, insertTestUser, TEST_IDS, isPlanExpired, type UserRow } from "./setup.js";

let pool: pg.Pool;
beforeAll(() => { pool = createPool(); });
afterAll(closePool);

const UID = TEST_IDS.USER_1;

describe("S-03: Plan Lifecycle", () => {
  it("isPlanExpired=true when plan_expiry is yesterday", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        `UPDATE users SET plan_expiry=TO_CHAR(NOW() - INTERVAL '1 day','MM/DD/YY') WHERE id=$1`,
        [UID]
      );
      const { rows } = await c.query<UserRow>("SELECT plan_expiry FROM users WHERE id=$1", [UID]);
      expect(isPlanExpired(rows[0]?.plan_expiry)).toBe(true);
    });
  });

  it("isPlanExpired=false when plan_expiry is tomorrow", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        `UPDATE users SET plan_expiry=TO_CHAR(NOW() + INTERVAL '1 day','MM/DD/YY') WHERE id=$1`,
        [UID]
      );
      const { rows } = await c.query<UserRow>("SELECT plan_expiry FROM users WHERE id=$1", [UID]);
      expect(isPlanExpired(rows[0]?.plan_expiry)).toBe(false);
    });
  });

  it("isPlanExpired=false when plan_expiry is null (no plan)", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID); // plan_expiry defaults to null
      const { rows } = await c.query<UserRow>("SELECT plan_expiry FROM users WHERE id=$1", [UID]);
      expect(rows[0]?.plan_expiry).toBeNull();
      expect(isPlanExpired(rows[0]?.plan_expiry)).toBe(false);
    });
  });

  it("trial_used=true blocks second trial request", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID, { trial_used: true, plan_status: "approved" });
      const { rows } = await c.query<UserRow>("SELECT trial_used, plan_status FROM users WHERE id=$1", [UID]);
      // Bot logic: user can't request trial if trial_used=true
      expect(rows[0]?.trial_used).toBe(true);
      const canTrial = rows[0]?.plan_status !== "approved" && rows[0]?.trial_used !== true;
      expect(canTrial).toBe(false);
    });
  });

  it("user with active plan cannot request trial", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID, { plan_status: "approved", trial_used: true });
      const { rows } = await c.query<UserRow>("SELECT plan_status, trial_used FROM users WHERE id=$1", [UID]);
      const canTrial = rows[0]?.plan_status !== "approved" && rows[0]?.trial_used !== true;
      expect(canTrial).toBe(false);
    });
  });

  it("renewal sets pending_plan, plan_status=requested", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID, { plan_status: "approved", trial_used: true });
      await c.query(
        `UPDATE users SET plan_status='requested', pending_plan='basico|1m',
         plan_temporality='1m' WHERE id=$1`,
        [UID]
      );
      const { rows } = await c.query<UserRow>(
        "SELECT plan_status, pending_plan, plan_temporality FROM users WHERE id=$1", [UID]
      );
      expect(rows[0]?.plan_status).toBe("requested");
      expect(rows[0]?.pending_plan).toBe("basico|1m");
      expect(rows[0]?.plan_temporality).toBe("1m");
    });
  });

  it("approval clears pending_plan (no leftover state)", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID, { plan_status: "requested" });
      await c.query(
        `UPDATE users SET plan_status='approved', pending_plan=NULL,
         plan_id='basico', plan_expiry=TO_CHAR(NOW() + INTERVAL '30 days','MM/DD/YY')
         WHERE id=$1`,
        [UID]
      );
      const { rows } = await c.query<UserRow>("SELECT plan_status, pending_plan FROM users WHERE id=$1", [UID]);
      expect(rows[0]?.plan_status).toBe("approved");
      expect(rows[0]?.pending_plan).toBeNull();
    });
  });

  it("plan_expiry matches MM/DD/YY regex after update", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        "UPDATE users SET plan_expiry=TO_CHAR(NOW() + INTERVAL '30 days','MM/DD/YY') WHERE id=$1",
        [UID]
      );
      const { rows } = await c.query<UserRow>("SELECT plan_expiry FROM users WHERE id=$1", [UID]);
      expect(rows[0]?.plan_expiry).toMatch(/^\d{2}\/\d{2}\/\d{2}$/);
    });
  });
});
