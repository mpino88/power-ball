import { defineConfig } from "vitest/config";

/**
 * Vitest configuration — Ballbot QA Suite v3.0
 *
 * Two logical groups:
 *   unit        → tests/unit/**       → no DB, <5 ms each
 *   integration → tests/integration/** → real Render DEV DB, <30 s each
 *
 * Integration tests run sequentially (singleFork) to avoid exhausting
 * the PostgreSQL connection pool on Render Free tier (max 25 connections).
 */
export default defineConfig({
  test: {
    environment: "node",
    globals: true,

    // Vitest auto-loads .env via dotenv — same vars tsx uses
    // Override with DATABASE_URL in CI environment secrets

    // Sequential execution for DB tests: prevents pool exhaustion
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },

    // Per-test timeout: 30 s for integration, 5 s for unit
    timeout: 30_000,
    hookTimeout: 15_000,

    // Reporters: verbose in dev, junit in CI (detected via CI env var)
    reporters: process.env.CI
      ? ["verbose", "junit"]
      : ["verbose"],
    outputFile: {
      junit: "test-results/junit.xml",
    },

    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist", "scripts"],

    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: ["src/bot.ts", "src/**/*.d.ts"],
    },
  },
});
