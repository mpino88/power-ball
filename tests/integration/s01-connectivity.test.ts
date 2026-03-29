/**
 * S-01: DB Connectivity & Schema
 * Verifies that the database is reachable and all 13 expected tables exist,
 * including pending_interactions (GAP-03 fix). Also checks critical indexes.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createPool, closePool } from "./setup.js";

let pool: pg.Pool;

beforeAll(() => { pool = createPool(); });
afterAll(closePool);

const EXPECTED_TABLES = [
  "users", "user_menus", "plans", "draws", "custom_strategies",
  "announcements", "suggestions", "payment_methods", "testing_config",
  "leads", "strategy_requests", "referrals",
  "pending_interactions",   // GAP-03 fix
] as const;

const CRITICAL_INDEXES = [
  { table: "draws",                  idx: "idx_draws_date" },
  { table: "draws",                  idx: "idx_draws_game" },
  { table: "users",                  idx: "idx_users_plan_status" },
  { table: "users",                  idx: "idx_users_referred_by" },
  { table: "user_menus",             idx: "idx_user_menus_user" },
  { table: "referrals",              idx: "idx_referrals_referred" },
  { table: "referrals",              idx: "idx_referrals_rewarded" },
  { table: "leads",                  idx: "idx_leads_user" },
  { table: "strategy_requests",      idx: "idx_strategy_requests_user" },
  { table: "pending_interactions",   idx: "idx_pending_interactions_expires" },
] as const;

describe("S-01: DB Connectivity & Schema", () => {
  it("ping — database responds to SELECT NOW()", async () => {
    const { rows } = await pool.query<{ ts: Date; db: string; ver: string }>(
      "SELECT NOW() as ts, current_database() as db, version() as ver"
    );
    expect(rows[0]?.ts).toBeInstanceOf(Date);
    expect(rows[0]?.db).toBeTruthy();
    console.log(`[S-01] PostgreSQL: ${rows[0]?.ver?.split(" ").slice(0, 2).join(" ")}`);
  });

  it("connection pool health — <90 active connections", async () => {
    const { rows } = await pool.query<{ c: string }>(
      "SELECT count(*) as c FROM pg_stat_activity WHERE datname=current_database()"
    );
    const conns = Number(rows[0]?.c ?? 0);
    expect(conns, `Active connections: ${conns} (limit 90)`).toBeLessThan(90);
  });

  describe("tables exist", () => {
    let foundTables: Set<string>;

    beforeAll(async () => {
      const { rows } = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
      );
      foundTables = new Set(rows.map((r) => r.tablename));
    });

    for (const table of EXPECTED_TABLES) {
      it(`table '${table}' exists`, () => {
        expect(
          foundTables.has(table),
          `Table '${table}' NOT FOUND — run schema.sql against the DB`
        ).toBe(true);
      });
    }
  });

  describe("critical indexes exist", () => {
    let existingIndexes: Set<string>;

    beforeAll(async () => {
      const { rows } = await pool.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname='public'"
      );
      existingIndexes = new Set(rows.map((r) => r.indexname));
    });

    for (const { table, idx } of CRITICAL_INDEXES) {
      it(`index '${idx}' on ${table}`, () => {
        expect(
          existingIndexes.has(idx),
          `Index '${idx}' MISSING on ${table} — queries will be slow`
        ).toBe(true);
      });
    }
  });

  it("pending_interactions PK is user_id (single pending per user)", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema   = kcu.table_schema
       WHERE tc.constraint_type = 'PRIMARY KEY'
         AND tc.table_name = 'pending_interactions'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.column_name).toBe("user_id");
  });

  it("pending_interactions has all 7 required columns", async () => {
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'pending_interactions' AND table_schema = 'public'`
    );
    const cols = new Set(rows.map((r) => r.column_name));
    const required = ["user_id", "type", "plan_id", "plan_name", "temporality", "expires_at", "created_at"];
    for (const col of required) {
      expect(cols.has(col), `Column '${col}' missing from pending_interactions`).toBe(true);
    }
  });
});
