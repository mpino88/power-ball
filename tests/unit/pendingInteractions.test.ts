/**
 * tests/unit/pendingInteractions.test.ts
 * ══════════════════════════════════════════════════════════════════════
 * Unit tests for pending interaction logic — no DB required.
 * Validates TTL math and type-guard patterns used by the repository.
 * ══════════════════════════════════════════════════════════════════════
 */

import { describe, it, expect } from "vitest";

// ── TTL Math ─────────────────────────────────────────────────────────────────

const TTL_MINUTES = 30;

function makeTTLExpiry(offsetMs = TTL_MINUTES * 60 * 1000): Date {
  return new Date(Date.now() + offsetMs);
}

function isExpiredTTL(expiresAt: Date): boolean {
  return expiresAt < new Date();
}

function isActiveTTL(expiresAt: Date): boolean {
  return expiresAt > new Date();
}

describe("Pending Interaction TTL math", () => {
  it("fresh pending (now + 30 min) is active", () => {
    const exp = makeTTLExpiry();
    expect(isActiveTTL(exp)).toBe(true);
    expect(isExpiredTTL(exp)).toBe(false);
  });

  it("pending 1ms in the future is still active", () => {
    const exp = makeTTLExpiry(1);
    expect(isActiveTTL(exp)).toBe(true);
  });

  it("pending 1ms in the past is expired", () => {
    const exp = makeTTLExpiry(-1);
    expect(isExpiredTTL(exp)).toBe(true);
    expect(isActiveTTL(exp)).toBe(false);
  });

  it("pending 1 second in the past is expired", () => {
    expect(isExpiredTTL(makeTTLExpiry(-1_000))).toBe(true);
  });

  it("pending 30 minutes ago is expired", () => {
    expect(isExpiredTTL(makeTTLExpiry(-TTL_MINUTES * 60 * 1000))).toBe(true);
  });

  it("TTL of 30 minutes is 1_800_000 ms", () => {
    const exp = makeTTLExpiry();
    const diff = exp.getTime() - Date.now();
    expect(diff).toBeGreaterThanOrEqual(TTL_MINUTES * 60 * 1000 - 10); // ≤10ms drift
    expect(diff).toBeLessThanOrEqual(TTL_MINUTES * 60 * 1000 + 10);
  });
});

// ── Type discriminator ────────────────────────────────────────────────────────

type PendingType = "plan_request" | "plan_renewal";

function isPendingType(value: string): value is PendingType {
  return value === "plan_request" || value === "plan_renewal";
}

describe("PendingInteraction type guard", () => {
  it("accepts plan_request", () => {
    expect(isPendingType("plan_request")).toBe(true);
  });

  it("accepts plan_renewal", () => {
    expect(isPendingType("plan_renewal")).toBe(true);
  });

  it("rejects unknown string", () => {
    expect(isPendingType("unknown")).toBe(false);
    expect(isPendingType("")).toBe(false);
    expect(isPendingType("PLAN_REQUEST")).toBe(false); // case sensitive
  });
});

// ── UPSERT semantics ─────────────────────────────────────────────────────────

interface PendingInteraction {
  planId: string;
  planName: string;
  temporality: string;
}

/**
 * Simulates the in-memory UPSERT behaviour that the DB repository replicates.
 * Used to document the expected behaviour of ON CONFLICT DO UPDATE.
 */
function simulateUpsert(
  store: Map<number, PendingInteraction>,
  userId: number,
  data: PendingInteraction,
): void {
  store.set(userId, data); // replaces existing
}

describe("UPSERT semantics (single row per user)", () => {
  it("stores new pending", () => {
    const store = new Map<number, PendingInteraction>();
    simulateUpsert(store, 1, { planId: "basico", planName: "Básico", temporality: "1m" });
    expect(store.get(1)).toEqual({ planId: "basico", planName: "Básico", temporality: "1m" });
  });

  it("overwrites existing pending (user changed plan before sending phone)", () => {
    const store = new Map<number, PendingInteraction>();
    simulateUpsert(store, 1, { planId: "basico", planName: "Básico", temporality: "1m" });
    simulateUpsert(store, 1, { planId: "pro", planName: "Pro", temporality: "3m" });
    expect(store.size).toBe(1); // only 1 entry
    expect(store.get(1)?.planId).toBe("pro");
  });

  it("stores independently for different users", () => {
    const store = new Map<number, PendingInteraction>();
    simulateUpsert(store, 1, { planId: "basico", planName: "Básico", temporality: "7d" });
    simulateUpsert(store, 2, { planId: "pro", planName: "Pro", temporality: "1m" });
    expect(store.size).toBe(2);
    expect(store.get(1)?.planId).toBe("basico");
    expect(store.get(2)?.planId).toBe("pro");
  });

  it("delete clears only the target user", () => {
    const store = new Map<number, PendingInteraction>();
    simulateUpsert(store, 1, { planId: "basico", planName: "Básico", temporality: "1m" });
    simulateUpsert(store, 2, { planId: "pro", planName: "Pro", temporality: "3m" });
    store.delete(1);
    expect(store.has(1)).toBe(false);
    expect(store.has(2)).toBe(true);
  });
});
