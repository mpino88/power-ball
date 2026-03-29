/**
 * S-17: Environment Variables Audit
 * Verifies all required env vars are present and correctly formatted.
 * GAP flags are surfaced as named test results.
 *
 * Note: AUTO_DRAW_SECRET is expected to FAIL until GAP-02 is manually resolved.
 *       DATABASE_SSL should be 'false' on Render (GAP-01) but 'true' locally.
 */

import { describe, it, expect } from "vitest";

describe("S-17: Environment Variables Audit", () => {

  it("DATABASE_URL is set and starts with postgres://", () => {
    const url = process.env.DATABASE_URL ?? "";
    expect(url, "DATABASE_URL is missing").toBeTruthy();
    expect(url, "DATABASE_URL must start with postgres://").toMatch(/^postgres(ql)?:\/\//i);
  });

  it("DATABASE_SSL is defined (true locally, false on Render internal URL — GAP-01)", () => {
    const ssl = process.env.DATABASE_SSL;
    // On Render internal URL ssl must be false; locally it's true.
    // This test ensures the var is explicitly set in ALL environments.
    expect(ssl, "DATABASE_SSL must be explicitly set ('true' or 'false')").toBeTruthy();
    expect(["true", "false"], "DATABASE_SSL must be 'true' or 'false'").toContain(ssl);
  });

  it("TELEGRAM_BOT_TOKEN is set and has correct format (number:alphanum)", () => {
    const token = process.env.TELEGRAM_BOT_TOKEN ?? "";
    expect(token, "TELEGRAM_BOT_TOKEN is missing").toBeTruthy();
    expect(token, "TELEGRAM_BOT_TOKEN format should be '123456789:AAAA...'").toMatch(/^\d+:[A-Za-z0-9_-]+$/);
  });

  it("BOT_OWNER_ID is set and contains only numeric IDs (single or comma-separated)", () => {
    const ownerId = process.env.BOT_OWNER_ID ?? "";
    expect(ownerId, "BOT_OWNER_ID is missing").toBeTruthy();
    // Supports single ID '12345' or multiple owners '12345,67890'
    expect(ownerId, "BOT_OWNER_ID must be numeric IDs (comma-separated allowed)").toMatch(/^\d+(,\d+)*$/);
  });

  it("WEBHOOK_URL is set and is a valid HTTPS URL (required on Render)", () => {
    const url = process.env.WEBHOOK_URL ?? "";
    // WEBHOOK_URL is only required in production (Render). Locally it may be unset.
    if (url) {
      expect(url, "WEBHOOK_URL must start with https://").toMatch(/^https:\/\//);
    } else {
      console.warn("[S-17] WEBHOOK_URL not set — acceptable locally, required on Render");
    }
  });

  it("AUTO_DRAW_SECRET is set (GAP-02 — requires manual Render Dashboard action)", () => {
    const secret = process.env.AUTO_DRAW_SECRET ?? "";
    // This test FAILS until GAP-02 is resolved in Render Dashboard.
    // Resolution: Add AUTO_DRAW_SECRET env var in Render → Environment section.
    expect(secret, "[GAP-02] AUTO_DRAW_SECRET not set — webhook endpoint is insecure").toBeTruthy();
  });

  it("GOOGLE_SPREADSHEET_ID is defined or absent (GAP-05: Sheets integration not in use)", () => {
    // GAP-05: intentionally empty — Google Sheets integration disabled.
    // If defined, must not be a raw placeholder. If absent, that's also acceptable.
    const val = process.env.GOOGLE_SPREADSHEET_ID;
    if (val !== undefined && val !== "") {
      expect(val).not.toContain("<CHANGE_ME>");
    }
    // Log status for visibility
    console.log(`[S-17] GOOGLE_SPREADSHEET_ID: ${val === undefined ? "not set (GAP-05 OK)" : val === "" ? "empty (GAP-05 OK)" : "set"}`);
  });

  it("SHEET_CLIENT_EMAIL is defined or absent (GAP-05: Sheets integration not in use)", () => {
    // GAP-05: same as above.
    const val = process.env.SHEET_CLIENT_EMAIL;
    if (val !== undefined && val !== "") {
      expect(val).not.toContain("<CHANGE_ME>");
    }
    console.log(`[S-17] SHEET_CLIENT_EMAIL: ${val === undefined ? "not set (GAP-05 OK)" : val === "" ? "empty (GAP-05 OK)" : "set"}`);
  });

  it("no required env var contains the literal placeholder string '<CHANGE_ME>'", () => {
    const vars = [
      "DATABASE_URL", "TELEGRAM_BOT_TOKEN", "BOT_OWNER_ID",
      "WEBHOOK_URL", "AUTO_DRAW_SECRET",
    ];
    for (const name of vars) {
      const val = process.env[name] ?? "";
      expect(val, `${name} still has placeholder value`).not.toContain("<CHANGE_ME>");
      expect(val, `${name} still has placeholder value`).not.toContain("CHANGE_ME");
    }
  });
});
