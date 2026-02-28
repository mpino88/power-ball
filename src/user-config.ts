/**
 * Whitelist y menús extra por usuario.
 * Persistencia: Google Sheet (si GOOGLE_SHEET_ID + credenciales) o JSON en data/bot-users.json.
 * BOT_OWNER_ID = único administrador; solo usuarios en allowed pueden usar el bot.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

const CONFIG_DIR = path.join(process.cwd(), "data");
const CONFIG_PATH = path.join(CONFIG_DIR, "bot-users.json");

export const EXTRA_MENU_IDS = ["est_grupos", "est_individuales"] as const;
export type ExtraMenuId = (typeof EXTRA_MENU_IDS)[number];

export const EXTRA_MENU_LABELS: Record<ExtraMenuId, string> = {
  est_grupos: "📊 Est. grupos",
  est_individuales: "📈 Est. individuales",
};

interface UsersConfig {
  allowed: number[];
  menus: Record<string, ExtraMenuId[]>;
}

const defaultConfig: UsersConfig = { allowed: [], menus: {} };
let config: UsersConfig = { ...defaultConfig };

const SHEET_HEADERS = ["userId", "est_grupos", "est_individuales"] as const;
type SheetRow = { userId: string; est_grupos: string; est_individuales: string };

function useGoogleSheet(): boolean {
  const id = process.env.GOOGLE_SHEET_ID;
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  return Boolean(id && (json || (email && key)));
}

function getSheetAuth(): JWT | null {
  const json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY;
  if (json) {
    try {
      const cred = JSON.parse(json) as { client_email?: string; private_key?: string };
      if (cred.client_email && cred.private_key) {
        return new JWT({
          email: cred.client_email,
          key: cred.private_key,
          scopes: ["https://www.googleapis.com/auth/spreadsheets"],
        });
      }
    } catch (e) {
      console.error("Error parsing GOOGLE_SERVICE_ACCOUNT_JSON:", e);
      return null;
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

async function loadFromSheet(): Promise<UsersConfig> {
  const sheetId = process.env.GOOGLE_SHEET_ID!;
  const auth = getSheetAuth();
  if (!auth) return { ...defaultConfig };
  const doc = new GoogleSpreadsheet(sheetId, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  if (!sheet) return { ...defaultConfig };
  try {
    await sheet.loadHeaderRow(1);
  } catch {
    await sheet.setHeaderRow([...SHEET_HEADERS], 1);
    return { ...defaultConfig };
  }
  const rows = await sheet.getRows<SheetRow>({ offset: 0 });
  const allowed: number[] = [];
  const menus: Record<string, ExtraMenuId[]> = {};
  for (const row of rows) {
    const uidStr = String(row.get("userId") ?? "").trim();
    const uid = parseInt(uidStr, 10);
    if (uidStr === "" || Number.isNaN(uid)) continue;
    allowed.push(uid);
    const g = String(row.get("est_grupos") ?? "").trim();
    const i = String(row.get("est_individuales") ?? "").trim();
    const menuIds: ExtraMenuId[] = [];
    if (g === "1" || g.toLowerCase() === "true") menuIds.push("est_grupos");
    if (i === "1" || i.toLowerCase() === "true") menuIds.push("est_individuales");
    menus[uidStr] = menuIds;
  }
  return { allowed, menus };
}

function loadFromFile(): UsersConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = readFileSync(CONFIG_PATH, "utf8");
      const data = JSON.parse(raw) as UsersConfig;
      return {
        allowed: Array.isArray(data.allowed) ? data.allowed : [],
        menus: data.menus && typeof data.menus === "object" ? data.menus : {},
      };
    }
  } catch (e) {
    console.error("Error loading user config:", e);
  }
  return { ...defaultConfig };
}

async function saveToSheet(): Promise<void> {
  const sheetId = process.env.GOOGLE_SHEET_ID!;
  const auth = getSheetAuth();
  if (!auth) return;
  const doc = new GoogleSpreadsheet(sheetId, auth);
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[0];
  if (!sheet) return;
  try {
    await sheet.loadHeaderRow(1);
  } catch {
    await sheet.setHeaderRow([...SHEET_HEADERS], 1);
  }
  await sheet.clearRows();
  const rows: SheetRow[] = config.allowed.map((uid) => {
    const key = String(uid);
    const extra = config.menus[key] ?? [];
    return {
      userId: key,
      est_grupos: extra.includes("est_grupos") ? "1" : "0",
      est_individuales: extra.includes("est_individuales") ? "1" : "0",
    };
  });
  if (rows.length > 0) await sheet.addRows(rows);
}

function saveToFile(): void {
  try {
    if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  } catch (e) {
    console.error("Error saving user config:", e);
  }
}

async function persist(): Promise<void> {
  if (useGoogleSheet()) await saveToSheet();
  else saveToFile();
}

/** Carga la config desde Sheet o archivo. Llamar al arranque del bot. */
export async function initUserConfig(): Promise<void> {
  if (useGoogleSheet()) config = await loadFromSheet();
  else config = loadFromFile();
}

export function getOwnerId(): number | null {
  const id = process.env.BOT_OWNER_ID;
  if (!id) return null;
  const n = parseInt(id, 10);
  return Number.isNaN(n) ? null : n;
}

export function isAllowed(userId: number): boolean {
  const owner = getOwnerId();
  if (owner === null) return true;
  if (userId === owner) return true;
  return config.allowed.includes(userId);
}

export function getExtraMenus(userId: number): ExtraMenuId[] {
  const list = config.menus[String(userId)];
  return Array.isArray(list) ? list.filter((m) => EXTRA_MENU_IDS.includes(m)) : [];
}

export function getAllowedUsers(): number[] {
  return [...config.allowed];
}

export async function addAllowed(userId: number): Promise<void> {
  if (!config.allowed.includes(userId)) {
    config.allowed.push(userId);
    await persist();
  }
}

export async function removeAllowed(userId: number): Promise<void> {
  config.allowed = config.allowed.filter((id) => id !== userId);
  await persist();
}

export async function setExtraMenus(userId: number, menuIds: ExtraMenuId[]): Promise<void> {
  const key = String(userId);
  config.menus[key] = menuIds.filter((m) => EXTRA_MENU_IDS.includes(m));
  await persist();
}

export async function toggleExtraMenu(userId: number, menuId: ExtraMenuId): Promise<boolean> {
  const key = String(userId);
  const current = config.menus[key] ?? [];
  const has = current.includes(menuId);
  if (has) {
    config.menus[key] = current.filter((m) => m !== menuId);
  } else {
    config.menus[key] = [...current, menuId];
  }
  await persist();
  return !has;
}

export function isOwner(userId: number): boolean {
  const owner = getOwnerId();
  return owner !== null && userId === owner;
}
