import { JWT } from "google-auth-library";

/**
 * Parses the Google Service Account JSON, handling escaped newlines.
 */
function parseSheetJson(json: string): Record<string, unknown> | null {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    const oneLine = json.replace(/\r\n/g, " ").replace(/\n/g, " ").replace(/\r/g, " ").trim();
    try {
      return JSON.parse(oneLine) as Record<string, unknown>;
    } catch (e) {
      console.error("[GoogleSheetConfig] Error parsing GOOGLE_SERVICE_ACCOUNT_JSON:", e);
      return null;
    }
  }
}

export function getSheetAuth(): JWT | null {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (json) {
    const cred = parseSheetJson(json) as { client_email?: string; private_key?: string } | null;
    if (cred?.client_email && cred?.private_key) {
      const privateKey = cred.private_key.replace(/\\n/g, "\n");
      return new JWT({
        email: cred.client_email,
        key: privateKey,
        scopes: ["https://www.googleapis.com/auth/spreadsheets"],
      });
    }
  }
  if (email && key) {
    const privateKey = key.replace(/\\n/g, "\n");
    return new JWT({
      email,
      key: privateKey,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"],
    });
  }
  return null;
}

export function getSheetId(): string | null {
  const id = process.env.GOOGLE_SHEET_ID?.trim();
  return id || null;
}

export function getSheetClientEmail(): string | null {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (json) {
    try {
      const cred = JSON.parse(json) as { client_email?: string };
      return cred.client_email ?? null;
    } catch {
      return null;
    }
  }
  return process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL ?? null;
}

export function useGoogleSheet(): boolean {
  return getSheetId() !== null && getSheetAuth() !== null;
}
