/**
 * S-05 to S-13: CRUD suites — bundled for brevity.
 * Each describe block is fully autonomous via withRollback.
 *
 *   S-05  Announcements CRUD
 *   S-06  Payment Methods CRUD
 *   S-07  Suggestions Flow
 *   S-08  Leads Capture & Upsert
 *   S-09  Strategy Requests
 *   S-10  Testing Config (cutoff date)
 *   S-11  Referral System
 *   S-12  Strategy Repository
 *   S-13  Plans Repository
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createPool, closePool, withRollback, insertTestUser, TEST_IDS } from "./setup.js";

let pool: pg.Pool;
beforeAll(() => { pool = createPool(); });
afterAll(closePool);

const UID  = TEST_IDS.USER_1;
const UID2 = TEST_IDS.USER_2;

// ─── S-05  ANNOUNCEMENTS ─────────────────────────────────────────────────────

describe("S-05: Announcements CRUD", () => {
  it("create → read → edit → delete", async () => {
    await withRollback(pool, async (c) => {
      const ts = Date.now();
      await c.query("INSERT INTO announcements (text, timestamp) VALUES ($1,$2)", ["[TEST] Anuncio 101%", ts]);

      const { rows: r1 } = await c.query<{ text: string }>("SELECT text FROM announcements WHERE timestamp=$1", [ts]);
      expect(r1[0]?.text).toBe("[TEST] Anuncio 101%");

      await c.query("UPDATE announcements SET text=$1 WHERE timestamp=$2", ["[TEST] EDITADO", ts]);
      const { rows: r2 } = await c.query<{ text: string }>("SELECT text FROM announcements WHERE timestamp=$1", [ts]);
      expect(r2[0]?.text).toBe("[TEST] EDITADO");

      await c.query("DELETE FROM announcements WHERE timestamp=$1", [ts]);
      const { rows: r3 } = await c.query("SELECT id FROM announcements WHERE timestamp=$1", [ts]);
      expect(r3).toHaveLength(0);
    });
  });

  it("announcements list is ordered by timestamp", async () => {
    await withRollback(pool, async (c) => {
      const t1 = Date.now();
      const t2 = t1 + 1000;
      await c.query("INSERT INTO announcements (text,timestamp) VALUES ('A',$1),('B',$2)", [t1, t2]);
      const { rows } = await c.query<{ timestamp: string }>(
        "SELECT timestamp FROM announcements WHERE timestamp IN ($1,$2) ORDER BY timestamp ASC", [t1, t2]
      );
      expect(Number(rows[0]?.timestamp)).toBe(t1);
      expect(Number(rows[1]?.timestamp)).toBe(t2);
    });
  });
});

// ─── S-06  PAYMENT METHODS ───────────────────────────────────────────────────

describe("S-06: Payment Methods CRUD", () => {
  it("create → read → edit → delete", async () => {
    await withRollback(pool, async (c) => {
      const { rows: ins } = await c.query<{ id: number }>(
        "INSERT INTO payment_methods (name, details) VALUES ($1,$2) RETURNING id",
        ["[TEST] Zelle", "test@bliss.com"]
      );
      const pmId = ins[0]?.id;
      expect(pmId).toBeTruthy();

      const { rows: r1 } = await c.query<{ name: string }>("SELECT name FROM payment_methods WHERE id=$1", [pmId]);
      expect(r1[0]?.name).toBe("[TEST] Zelle");

      await c.query("UPDATE payment_methods SET name=$1 WHERE id=$2", ["[TEST] Zelle EDITED", pmId]);
      const { rows: r2 } = await c.query<{ name: string }>("SELECT name FROM payment_methods WHERE id=$1", [pmId]);
      expect(r2[0]?.name).toBe("[TEST] Zelle EDITED");

      await c.query("DELETE FROM payment_methods WHERE id=$1", [pmId]);
      const { rows: r3 } = await c.query("SELECT id FROM payment_methods WHERE id=$1", [pmId]);
      expect(r3).toHaveLength(0);
    });
  });
});

// ─── S-07  SUGGESTIONS ───────────────────────────────────────────────────────

describe("S-07: Suggestions Flow", () => {
  it("stores suggestion with all required fields", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      const { rows } = await c.query<{ id: number; nombre: string; telefono: string; fecha: string }>(
        `INSERT INTO suggestions (user_id, text, nombre, telefono, fecha)
         VALUES ($1,$2,'Test Bliss','5551234567',TO_CHAR(NOW(),'DD/MM/YYYY HH24:MI'))
         RETURNING id, nombre, telefono, fecha`,
        [UID, "[TEST] Sugerencia de prueba"]
      );
      expect(rows[0]?.id).toBeTruthy();
      expect(rows[0]?.nombre).toBe("Test Bliss");
      expect(rows[0]?.telefono).toBe("5551234567");
      expect(rows[0]?.fecha).toBeTruthy();
    });
  });

  it("reads suggestions by user_id", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        "INSERT INTO suggestions (user_id, text) VALUES ($1,'test sug')",
        [UID]
      );
      const { rows } = await c.query("SELECT id FROM suggestions WHERE user_id=$1", [UID]);
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ─── S-08  LEADS ─────────────────────────────────────────────────────────────

describe("S-08: Leads Capture & Upsert", () => {
  it("inserts lead with status=trial_active", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        `INSERT INTO leads (user_id, nombre, telefono, plan, temporality, fecha, status)
         VALUES ($1,'Test Bliss','5551234567','basico','7d',TO_CHAR(NOW(),'DD/MM/YYYY HH24:MI'),'trial_active')`,
        [UID]
      );
      const { rows } = await c.query<{ status: string }>("SELECT status FROM leads WHERE user_id=$1", [UID]);
      expect(rows[0]?.status).toBe("trial_active");
    });
  });

  it("UPSERT updates status and temporality without duplicating", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await c.query(
        `INSERT INTO leads (user_id, nombre, telefono, plan, temporality, fecha, status)
         VALUES ($1,'Bliss','555','basico','7d',TO_CHAR(NOW(),'DD/MM/YYYY'),'trial_active')`,
        [UID]
      );
      await c.query(
        `INSERT INTO leads (user_id, nombre, telefono, plan, temporality, fecha, status)
         VALUES ($1,'Bliss','555','basico','1m',TO_CHAR(NOW(),'DD/MM/YYYY'),'renewal_requested')
         ON CONFLICT (user_id) DO UPDATE SET status=EXCLUDED.status, temporality=EXCLUDED.temporality`,
        [UID]
      );
      const { rows: countRows } = await c.query<{ c: string }>("SELECT count(*) as c FROM leads WHERE user_id=$1", [UID]);
      expect(Number(countRows[0]?.c)).toBe(1);

      const { rows } = await c.query<{ status: string; temporality: string }>(
        "SELECT status, temporality FROM leads WHERE user_id=$1", [UID]
      );
      expect(rows[0]?.status).toBe("renewal_requested");
      expect(rows[0]?.temporality).toBe("1m");
    });
  });

  it("UNIQUE(user_id) constraint prevents duplicate insert", async () => {
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
});

// ─── S-09  STRATEGY REQUESTS ─────────────────────────────────────────────────

describe("S-09: Strategy Requests", () => {
  it("inserts strategy request and deduplicates via ON CONFLICT", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      const ts1 = Date.now();
      const ts2 = ts1 + 1000;
      for (const ts of [ts1, ts2]) {
        await c.query(
          `INSERT INTO strategy_requests (user_id, menu_id, requested_at)
           VALUES ($1,'strat_test',$2)
           ON CONFLICT (user_id, menu_id) DO UPDATE SET requested_at=EXCLUDED.requested_at`,
          [UID, ts]
        );
      }
      const { rows } = await c.query<{ c: string }>(
        "SELECT count(*) as c FROM strategy_requests WHERE user_id=$1 AND menu_id='strat_test'",
        [UID]
      );
      expect(Number(rows[0]?.c)).toBe(1);
    });
  });
});

// ─── S-10  TESTING CONFIG ────────────────────────────────────────────────────

describe("S-10: Testing Config (cutoff date)", () => {
  it("saves and loads cutoff date", async () => {
    await withRollback(pool, async (c) => {
      const key = `cutoff_${UID}`;
      await c.query(
        "INSERT INTO testing_config (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
        [key, "03/15/24"]
      );
      const { rows } = await c.query<{ value: string }>("SELECT value FROM testing_config WHERE key=$1", [key]);
      expect(rows[0]?.value).toBe("03/15/24");
    });
  });

  it("updates cutoff date", async () => {
    await withRollback(pool, async (c) => {
      const key = `cutoff_${UID}`;
      await c.query("INSERT INTO testing_config (key,value) VALUES ($1,'03/15/24') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key]);
      await c.query("UPDATE testing_config SET value='04/01/25' WHERE key=$1", [key]);
      const { rows } = await c.query<{ value: string }>("SELECT value FROM testing_config WHERE key=$1", [key]);
      expect(rows[0]?.value).toBe("04/01/25");
    });
  });
});

// ─── S-11  REFERRALS ─────────────────────────────────────────────────────────

describe("S-11: Referral System", () => {
  it("creates referral with rewarded=false", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await insertTestUser(c, UID2);
      await c.query(
        "INSERT INTO referrals (referrer_id, referred_id, rewarded) VALUES ($1,$2,FALSE) ON CONFLICT (referred_id) DO NOTHING",
        [UID, UID2]
      );
      const { rows } = await c.query<{ rewarded: boolean }>("SELECT rewarded FROM referrals WHERE referred_id=$1", [UID2]);
      expect(rows[0]?.rewarded).toBe(false);
    });
  });

  it("marks referral as rewarded with timestamp", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await insertTestUser(c, UID2);
      await c.query(
        "INSERT INTO referrals (referrer_id, referred_id, rewarded) VALUES ($1,$2,FALSE) ON CONFLICT DO NOTHING",
        [UID, UID2]
      );
      await c.query("UPDATE referrals SET rewarded=TRUE, rewarded_at=NOW() WHERE referred_id=$1", [UID2]);
      const { rows } = await c.query<{ rewarded: boolean; rewarded_at: Date }>(
        "SELECT rewarded, rewarded_at FROM referrals WHERE referred_id=$1", [UID2]
      );
      expect(rows[0]?.rewarded).toBe(true);
      expect(rows[0]?.rewarded_at).toBeInstanceOf(Date);
    });
  });

  it("UNIQUE(referred_id) prevents double-referral fraud", async () => {
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
});

// ─── S-12  STRATEGY REPOSITORY ───────────────────────────────────────────────

describe("S-12: Strategy Repository", () => {
  it("inserts strategy and reads it back", async () => {
    await withRollback(pool, async (c) => {
      await c.query(
        `INSERT INTO custom_strategies (id, titulo, descripcion, visibility)
         VALUES ('test_strat_bliss','[TEST] 101% Strat','desc','private')
         ON CONFLICT (id) DO UPDATE SET titulo=EXCLUDED.titulo`
      );
      const { rows } = await c.query<{ titulo: string; visibility: string }>(
        "SELECT titulo, visibility FROM custom_strategies WHERE id='test_strat_bliss'"
      );
      expect(rows[0]?.titulo).toBe("[TEST] 101% Strat");
      expect(rows[0]?.visibility).toBe("private");
    });
  });

  it("existing strategies count is non-negative", async () => {
    const { rows } = await pool.query<{ c: string }>("SELECT count(*) as c FROM custom_strategies");
    expect(Number(rows[0]?.c)).toBeGreaterThanOrEqual(0);
  });
});

// ─── S-13  PLANS REPOSITORY ──────────────────────────────────────────────────

describe("S-13: Plans Repository", () => {
  it("inserts and upserts a plan", async () => {
    await withRollback(pool, async (c) => {
      await c.query(
        `INSERT INTO plans (id, title, description, auto_approve, price_1m)
         VALUES ('test_plan_bliss','[TEST] Plan 101%','desc',FALSE,'$49')
         ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title`
      );
      const { rows } = await c.query<{ title: string; price_1m: string }>(
        "SELECT title, price_1m FROM plans WHERE id='test_plan_bliss'"
      );
      expect(rows[0]?.title).toBe("[TEST] Plan 101%");
      expect(rows[0]?.price_1m).toBe("$49");
    });
  });

  it("reads all plans without error", async () => {
    const { rows } = await pool.query("SELECT id, title, auto_approve FROM plans ORDER BY id");
    expect(Array.isArray(rows)).toBe(true);
    if (rows.length > 0) {
      console.log(`[S-13] Plans in DB: ${rows.map((r: { id: string }) => r.id).join(", ")}`);
    }
  });
});
