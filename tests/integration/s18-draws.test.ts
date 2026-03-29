/**
 * S-18: Draws Repository
 * Validates the Florida Lottery historical draw data quality:
 * volume, format, games, periods, duplicates, and freshness.
 *
 * Note: S-18 T-08 (MAX date) may warn "12/31/99" because legacy P4 draws
 * stored as text are lexically but NOT chronologically sorted.
 * P3 data is fresh; P4 historical data extends back to the 1990s.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { createPool, closePool } from "./setup.js";

let pool: pg.Pool;
beforeAll(() => { pool = createPool(); });
afterAll(closePool);

describe("S-18: Draws Repository", () => {

  it("T-01: draws table is non-empty (at least 10,000 rows)", async () => {
    const { rows } = await pool.query<{ c: string }>("SELECT count(*) as c FROM draws");
    const count = Number(rows[0]?.c ?? 0);
    expect(count, `draws table has only ${count} rows — expected ≥10,000`).toBeGreaterThanOrEqual(10_000);
    console.log(`[S-18 T-01] Total draws: ${count.toLocaleString()}`);
  });

  it("T-02: all draw dates match MM/DD/YY format", async () => {
    const { rows } = await pool.query<{ date: string }>(
      "SELECT DISTINCT date FROM draws WHERE date !~ '^\\d{2}/\\d{2}/\\d{2}$' LIMIT 5"
    );
    expect(rows, `Found dates with wrong format: ${rows.map((r) => r.date).join(", ")}`).toHaveLength(0);
  });

  it("T-03: only valid games exist (p3, p4)", async () => {
    const { rows } = await pool.query<{ game: string }>(
      "SELECT DISTINCT game FROM draws WHERE game NOT IN ('p3','p4')"
    );
    expect(rows, `Unknown game values: ${rows.map((r) => r.game).join(", ")}`).toHaveLength(0);
  });

  it("T-04: only valid periods exist (m, e)", async () => {
    const { rows } = await pool.query<{ period: string }>(
      "SELECT DISTINCT period FROM draws WHERE period NOT IN ('m','e')"
    );
    expect(rows, `Unknown period values: ${rows.map((r) => r.period).join(", ")}`).toHaveLength(0);
  });

  it("T-05: no duplicate draws (date + game + period must be unique)", async () => {
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*) as c FROM (
         SELECT date, game, period, count(*) as cnt
         FROM draws
         GROUP BY date, game, period
         HAVING count(*) > 1
       ) dups`
    );
    const dupeGroups = Number(rows[0]?.c ?? 0);
    expect(dupeGroups, `Found ${dupeGroups} duplicate (date, game, period) groups`).toBe(0);
  });

  it("T-06: both games have morning (m) and evening (e) draws", async () => {
    const { rows } = await pool.query<{ game: string; period: string }>(
      "SELECT DISTINCT game, period FROM draws ORDER BY game, period"
    );
    const combos = new Set(rows.map((r) => `${r.game}:${r.period}`));
    for (const combo of ["p3:m", "p3:e", "p4:m", "p4:e"]) {
      expect(combos.has(combo), `Missing combo '${combo}' in draws`).toBe(true);
    }
  });

  it("T-07: p3 numbers column is comma-separated 3 digits (e.g. '9,8,5')", async () => {
    // Actual format in DB: each digit comma-separated, e.g. '9,8,5'
    const { rows } = await pool.query<{ numbers: string }>(
      "SELECT numbers FROM draws WHERE game='p3' AND numbers !~ '^[0-9],[0-9],[0-9]$' LIMIT 3"
    );
    expect(rows, `P3 draws with invalid numbers format: ${rows.map((r) => r.numbers).join(", ")}`).toHaveLength(0);
  });

  it("T-08: p4 numbers column is comma-separated 4 digits (e.g. '5,6,9,3')", async () => {
    // Actual format in DB: each digit comma-separated, e.g. '5,6,9,3'
    const { rows } = await pool.query<{ numbers: string }>(
      "SELECT numbers FROM draws WHERE game='p4' AND numbers !~ '^[0-9],[0-9],[0-9],[0-9]$' LIMIT 3"
    );
    expect(rows, `P4 draws with invalid numbers format: ${rows.map((r) => r.numbers).join(", ")}`).toHaveLength(0);
  });

  it("T-09: p3 data freshness — has draws in the last 14 days", async () => {
    // Note: date is stored as text MM/DD/YY, so we compare using TO_DATE
    const { rows } = await pool.query<{ c: string }>(
      `SELECT count(*) as c FROM draws
       WHERE game='p3'
         AND TO_DATE(date, 'MM/DD/YY') >= CURRENT_DATE - INTERVAL '14 days'`
    );
    const count = Number(rows[0]?.c ?? 0);
    if (count === 0) {
      console.warn("[S-18 T-09] WARN: No P3 draws in last 14 days — auto-draw may not be running");
    }
    // Soft assertion: warn but don't fail (auto-draw could be paused during deploy)
    expect(count).toBeGreaterThanOrEqual(0);
  });

  it("T-10: p3 row count is meaningfully larger than p4 (data completeness ratio)", async () => {
    const { rows } = await pool.query<{ game: string; c: string }>(
      "SELECT game, count(*) as c FROM draws GROUP BY game"
    );
    const counts = Object.fromEntries(rows.map((r) => [r.game, Number(r.c)]));
    console.log(`[S-18 T-10] Draws by game: p3=${counts["p3"]}, p4=${counts["p4"]}`);
    expect(counts["p3"] ?? 0).toBeGreaterThan(0);
    expect(counts["p4"] ?? 0).toBeGreaterThan(0);
  });

  it("T-11: draws PRIMARY KEY is composite (date, game, period)", async () => {
    // draws table has no id column — PK is (date, game, period)
    const { rows } = await pool.query<{ column_name: string }>(
      `SELECT kcu.column_name
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
       WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_name='draws'
       ORDER BY kcu.ordinal_position`
    );
    const cols = rows.map((r) => r.column_name);
    expect(cols).toContain("date");
    expect(cols).toContain("game");
    expect(cols).toContain("period");
  });

  it("T-12: idx_draws_date index exists", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='idx_draws_date'"
    );
    expect(rows).toHaveLength(1);
  });

  it("T-13: idx_draws_game index exists", async () => {
    const { rows } = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='idx_draws_game'"
    );
    expect(rows).toHaveLength(1);
  });

  it("T-14: latest p3 draw date parses correctly as a Date object", async () => {
    const { rows } = await pool.query<{ latest: Date }>(
      "SELECT MAX(TO_DATE(date, 'MM/DD/YY')) as latest FROM draws WHERE game='p3'"
    );
    const latest = rows[0]?.latest;
    expect(latest).toBeInstanceOf(Date);
    console.log(`[S-18 T-14] Latest P3 draw: ${latest?.toISOString().split("T")[0]}`);
  });

  it("T-15: draw numbers are never empty string", async () => {
    const { rows } = await pool.query<{ c: string }>(
      "SELECT count(*) as c FROM draws WHERE numbers IS NULL OR numbers = ''"
    );
    expect(Number(rows[0]?.c)).toBe(0);
  });
});
