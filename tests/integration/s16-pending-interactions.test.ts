/**
 * S-16: Pending Interactions (GAP-03 Fix)
 * Verifies the pending_interactions table that replaces in-memory Maps.
 * Session state now survives Render process restarts.
 *
 * Covers: schema, SET/GET, UPSERT, TTL expiry, DELETE, clean-up,
 * session-survival simulation, type constraints, isolation.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createPool, closePool, withRollback, insertTestUser, TEST_IDS, type PendingInteractionRow } from "./setup.js";

let pool: pg.Pool;
beforeAll(() => { pool = createPool(); });
afterAll(closePool);

const UID  = TEST_IDS.USER_1;
const UID2 = TEST_IDS.USER_2;

// ─── helpers ─────────────────────────────────────────────────────────────────

async function setPending(
  c: pg.PoolClient,
  userId: bigint,
  type: "plan_request" | "plan_renewal",
  overrides: Partial<{ plan_id: string; plan_name: string; temporality: string; ttlSeconds: number }> = {}
) {
  const ttl = overrides.ttlSeconds ?? 1800;
  await c.query(
    `INSERT INTO pending_interactions
       (user_id, type, plan_id, plan_name, temporality, expires_at)
     VALUES ($1,$2,$3,$4,$5, NOW() + ($6 || ' seconds')::interval)
     ON CONFLICT (user_id) DO UPDATE
       SET type=EXCLUDED.type,
           plan_id=EXCLUDED.plan_id,
           plan_name=EXCLUDED.plan_name,
           temporality=EXCLUDED.temporality,
           expires_at=EXCLUDED.expires_at,
           created_at=NOW()`,
    [userId, type, overrides.plan_id ?? "basico", overrides.plan_name ?? "Plan Básico", overrides.temporality ?? "1m", ttl]
  );
}

async function getPending(c: pg.PoolClient, userId: bigint) {
  const { rows } = await c.query<PendingInteractionRow>(
    "SELECT * FROM pending_interactions WHERE user_id=$1 AND expires_at > NOW()",
    [userId]
  );
  return rows[0] ?? null;
}

async function deletePending(c: pg.PoolClient, userId: bigint) {
  await c.query("DELETE FROM pending_interactions WHERE user_id=$1", [userId]);
}

// ─── S-16 tests ──────────────────────────────────────────────────────────────

describe("S-16: Pending Interactions (GAP-03)", () => {

  it("table has all 7 required columns", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='pending_interactions' AND table_schema='public'`
    );
    const cols = new Set(rows.map((r) => r.column_name));
    for (const col of ["user_id", "type", "plan_id", "plan_name", "temporality", "expires_at", "created_at"]) {
      expect(cols.has(col), `Column '${col}' missing from pending_interactions`).toBe(true);
    }
  });

  it("PRIMARY KEY is user_id (one pending per user)", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_name='pending_interactions'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.column_name).toBe("user_id");
  });

  it("SET stores interaction and GET retrieves it", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await setPending(c, UID, "plan_request", { plan_id: "basico", plan_name: "Plan Básico", temporality: "7d" });
      const row = await getPending(c, UID);
      expect(row).not.toBeNull();
      expect(row?.type).toBe("plan_request");
      expect(row?.plan_id).toBe("basico");
      expect(row?.temporality).toBe("7d");
    });
  });

  it("UPSERT overwrites existing pending (no duplicate)", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await setPending(c, UID, "plan_request", { plan_id: "basico" });
      await setPending(c, UID, "plan_renewal", { plan_id: "pro", temporality: "1m" });
      const { rows } = await c.query<{ c: string }>(
        "SELECT count(*) as c FROM pending_interactions WHERE user_id=$1", [UID]
      );
      expect(Number(rows[0]?.c)).toBe(1);
      const row = await getPending(c, UID);
      expect(row?.type).toBe("plan_renewal");
      expect(row?.plan_id).toBe("pro");
    });
  });

  it("expired interaction is NOT returned by getPending", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      // Insert with -1 second TTL (already expired)
      await c.query(
        `INSERT INTO pending_interactions (user_id, type, plan_id, plan_name, temporality, expires_at)
         VALUES ($1,'plan_request','basico','Plan Básico','7d', NOW() - INTERVAL '1 second')`,
        [UID]
      );
      const row = await getPending(c, UID);
      expect(row).toBeNull();
    });
  });

  it("fresh interaction (TTL=30min) IS returned", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await setPending(c, UID, "plan_request", { ttlSeconds: 1800 });
      const row = await getPending(c, UID);
      expect(row).not.toBeNull();
    });
  });

  it("DELETE removes the interaction", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await setPending(c, UID, "plan_request");
      await deletePending(c, UID);
      const row = await getPending(c, UID);
      expect(row).toBeNull();
    });
  });

  it("DELETE is idempotent (second delete does not throw)", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await setPending(c, UID, "plan_request");
      await deletePending(c, UID);
      await expect(deletePending(c, UID)).resolves.not.toThrow();
    });
  });

  it("cleanExpiredPendingInteractions removes only expired rows", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await insertTestUser(c, UID2);
      // UID: fresh
      await setPending(c, UID, "plan_request", { ttlSeconds: 1800 });
      // UID2: already expired
      await c.query(
        `INSERT INTO pending_interactions (user_id, type, plan_id, plan_name, temporality, expires_at)
         VALUES ($1,'plan_renewal','pro','Plan Pro','1m', NOW() - INTERVAL '5 minutes')`,
        [UID2]
      );
      // Simulate cleanExpiredPendingInteractions
      await c.query("DELETE FROM pending_interactions WHERE expires_at <= NOW()");

      const fresh = await getPending(c, UID);
      expect(fresh).not.toBeNull();

      const { rows } = await c.query(
        "SELECT * FROM pending_interactions WHERE user_id=$1", [UID2]
      );
      expect(rows).toHaveLength(0);
    });
  });

  it("two users have independent pending interactions", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await insertTestUser(c, UID2);
      await setPending(c, UID,  "plan_request", { plan_id: "basico", temporality: "7d" });
      await setPending(c, UID2, "plan_renewal", { plan_id: "pro",    temporality: "1m" });

      const r1 = await getPending(c, UID);
      const r2 = await getPending(c, UID2);

      expect(r1?.type).toBe("plan_request");
      expect(r1?.plan_id).toBe("basico");
      expect(r2?.type).toBe("plan_renewal");
      expect(r2?.plan_id).toBe("pro");
    });
  });

  it("delete of UID1 does NOT affect UID2 pending", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await insertTestUser(c, UID2);
      await setPending(c, UID,  "plan_request");
      await setPending(c, UID2, "plan_renewal");
      await deletePending(c, UID);

      const r2 = await getPending(c, UID2);
      expect(r2).not.toBeNull();
    });
  });

  it("session survival simulation: process restart → interaction still readable", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      // Simulate process A writing to DB
      await setPending(c, UID, "plan_request", { plan_id: "basico", temporality: "7d" });

      // Simulate process B (after restart) reading from DB — same client simulates new process
      const row = await getPending(c, UID);
      expect(row).not.toBeNull();
      expect(row?.type).toBe("plan_request");
      expect(row?.plan_id).toBe("basico");
      // In real scenario: pendingPlanRequest Map is empty after restart, but DB has the row
    });
  });

  it("expires_at is set ~30 minutes in future for standard TTL", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await setPending(c, UID, "plan_request", { ttlSeconds: 1800 });
      const { rows } = await c.query<{ expires_at: Date }>(
        "SELECT expires_at FROM pending_interactions WHERE user_id=$1", [UID]
      );
      const expiresAt = rows[0]?.expires_at!;
      const now = new Date();
      const diffMs = expiresAt.getTime() - now.getTime();
      // Should be between 29 and 31 minutes
      expect(diffMs).toBeGreaterThan(29 * 60 * 1000);
      expect(diffMs).toBeLessThan(31 * 60 * 1000);
    });
  });

  it("type column accepts 'plan_request' and 'plan_renewal'", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      for (const type of ["plan_request", "plan_renewal"] as const) {
        await setPending(c, UID, type);
        const row = await getPending(c, UID);
        expect(row?.type).toBe(type);
      }
    });
  });

  it("created_at is set automatically on INSERT", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await setPending(c, UID, "plan_request");
      const { rows } = await c.query<{ created_at: Date }>(
        "SELECT created_at FROM pending_interactions WHERE user_id=$1", [UID]
      );
      expect(rows[0]?.created_at).toBeInstanceOf(Date);
    });
  });

  it("idx_pending_interactions_expires index exists", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='idx_pending_interactions_expires'"
    );
    expect(rows).toHaveLength(1);
  });

  it("getPending returns null when table is empty for that user", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      // No setPending call
      const row = await getPending(c, UID);
      expect(row).toBeNull();
    });
  });

  it("plan_id, plan_name, temporality are preserved through UPSERT", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      await setPending(c, UID, "plan_request", {
        plan_id: "ultra",
        plan_name: "Plan Ultra Premium",
        temporality: "3m"
      });
      const row = await getPending(c, UID);
      expect(row?.plan_id).toBe("ultra");
      expect(row?.plan_name).toBe("Plan Ultra Premium");
      expect(row?.temporality).toBe("3m");
    });
  });

  it("pending_interactions count starts at 0 for a fresh test user", async () => {
    await withRollback(pool, async (c) => {
      await insertTestUser(c, UID);
      const { rows } = await c.query<{ c: string }>(
        "SELECT count(*) as c FROM pending_interactions WHERE user_id=$1", [UID]
      );
      expect(Number(rows[0]?.c)).toBe(0);
    });
  });
});
