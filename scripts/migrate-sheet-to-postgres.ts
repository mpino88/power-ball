/**
 * Script de Migración: Google Sheet → PostgreSQL
 * Ejecutar UNA sola vez en el VPS antes del primer deploy con DATABASE_URL activo.
 *
 * Uso:
 *   DATABASE_URL=postgres://... GOOGLE_SHEET_ID=... GOOGLE_SERVICE_ACCOUNT_JSON='...' \
 *   npx tsx scripts/migrate-sheet-to-postgres.ts
 *
 * Orden de migración (respeta FK):
 *   1. plans → 2. users (sin FK, orden libre) → 3. user_menus → 4. custom_strategies
 */

import pg from "pg";
import { GoogleSpreadsheet } from "google-spreadsheet";
import { JWT } from "google-auth-library";

// ── Conexión ────────────────────────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const SA_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

if (!DATABASE_URL) throw new Error("Falta DATABASE_URL");
if (!SHEET_ID) throw new Error("Falta GOOGLE_SHEET_ID");
if (!SA_JSON) throw new Error("Falta GOOGLE_SERVICE_ACCOUNT_JSON");

const pool = new pg.Pool({ connectionString: DATABASE_URL });

function getAuth() {
  const creds = JSON.parse(SA_JSON!);
  return new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────
async function getSheet(doc: GoogleSpreadsheet, index: number) {
  await doc.loadInfo();
  const sheet = doc.sheetsByIndex[index];
  if (!sheet) throw new Error(`No hay hoja en índice ${index}`);
  await sheet.loadHeaderRow(1);
  return sheet;
}

// ── 1. Migrar Planes ─────────────────────────────────────────────────────────
async function migratePlans(doc: GoogleSpreadsheet, client: pg.PoolClient) {
  console.log("📦 Migrando planes...");
  const sheet = await getSheet(doc, 2); // 3ª pestaña
  const rows = await sheet.getRows();
  let count = 0;
  for (const row of rows) {
    const obj = row.toObject() as Record<string, string>;
    const id = obj["id"]?.trim();
    if (!id) continue;
    await client.query(
      `INSERT INTO plans (id, title, description, price, menu_ids, price_1m, price_3m, price_6m, price_9m, price_1a, auto_approve)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET
         title=EXCLUDED.title, description=EXCLUDED.description, price=EXCLUDED.price,
         menu_ids=EXCLUDED.menu_ids, price_1m=EXCLUDED.price_1m, price_3m=EXCLUDED.price_3m,
         price_6m=EXCLUDED.price_6m, price_9m=EXCLUDED.price_9m, price_1a=EXCLUDED.price_1a,
         auto_approve=EXCLUDED.auto_approve`,
      [
        id, obj["title"]||id, obj["description"]||"", obj["price"]||"", obj["menuIds"]||"",
        obj["price_1m"]||"", obj["price_3m"]||"", obj["price_6m"]||"",
        obj["price_9m"]||"", obj["price_1a"]||"",
        obj["autoApprove"] === "true"
      ]
    );
    count++;
  }
  console.log(`   ✅ ${count} planes migrados.`);
}

// ── 2. Migrar Usuarios ────────────────────────────────────────────────────────
async function migrateUsers(doc: GoogleSpreadsheet, client: pg.PoolClient): Promise<Map<string, string[]>> {
  console.log("👥 Migrando usuarios...");
  const sheet = await getSheet(doc, 0); // 1ª pestaña
  const headers = sheet.headerValues;
  const rows = await sheet.getRows();
  
  // Map uidStr → menu IDs para luego insertar user_menus
  const userMenusMap = new Map<string, string[]>();
  let count = 0;

  for (const row of rows) {
    const obj = row.toObject() as Record<string, string>;
    const values = headers.map((h: string) => String(obj[h] ?? "").trim());
    const getCol = (i: number) => i >= 0 && i < values.length ? values[i] : "";

    // Columnas — alineadas con user-config.ts COL_* constants
    const uidStr = values[0]?.trim();
    const uid = parseInt(uidStr, 10);
    if (!uidStr || isNaN(uid)) continue;

    const planStatus = values[6]?.trim().toLowerCase() || null;
    const planId = values[5]?.trim() || null;
    const name = values[1]?.trim() || null;
    const phone = values[2]?.trim() || null;
    const planTemp = values[7]?.trim() || null;
    const planExpiry = values[8]?.trim() || null;
    const trialUsed = values[9]?.trim() === "true";
    const pendingPlan = values[10]?.trim() || null;
    const role = values[11]?.trim() || "user";
    // Menús extra (pueden estar en columna 12+)
    const rawMenus = values[12]?.trim() || "";
    if (rawMenus) {
      userMenusMap.set(uidStr, rawMenus.split(",").map(m => m.trim()).filter(Boolean));
    }

    await client.query(
      `INSERT INTO users (id, username, phone, role, plan_id, plan_status, pending_plan, plan_temporality, plan_expiry, trial_used)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         username=EXCLUDED.username, phone=EXCLUDED.phone, role=EXCLUDED.role,
         plan_id=EXCLUDED.plan_id, plan_status=EXCLUDED.plan_status,
         pending_plan=EXCLUDED.pending_plan, plan_temporality=EXCLUDED.plan_temporality,
         plan_expiry=EXCLUDED.plan_expiry, trial_used=EXCLUDED.trial_used`,
      [uid, name, phone, role, planId, planStatus, pendingPlan, planTemp, planExpiry, trialUsed]
    );
    count++;
  }
  console.log(`   ✅ ${count} usuarios migrados.`);
  return userMenusMap;
}

// ── 3. Migrar User_Menus ──────────────────────────────────────────────────────
async function migrateUserMenus(userMenusMap: Map<string, string[]>, client: pg.PoolClient) {
  console.log("🗂  Migrando menús de usuarios...");
  let count = 0;
  for (const [uidStr, menus] of userMenusMap) {
    for (const menuId of menus) {
      await client.query(
        `INSERT INTO user_menus (user_id, menu_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [Number(uidStr), menuId]
      );
      count++;
    }
  }
  console.log(`   ✅ ${count} asignaciones de menú migradas.`);
}

// ── 4. Migrar Estrategias ─────────────────────────────────────────────────────
async function migrateStrategies(doc: GoogleSpreadsheet, client: pg.PoolClient) {
  console.log("🧠 Migrando estrategias personalizadas...");
  try {
    const sheet = await getSheet(doc, 1); // 2ª pestaña
    const rows = await sheet.getRows();
    let count = 0;
    for (const row of rows) {
      const obj = row.toObject() as Record<string, string>;
      const id = obj["id"]?.trim();
      if (!id) continue;
      await client.query(
        `INSERT INTO custom_strategies (id, titulo, descripcion, created_by, price, visibility, subscribers)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           titulo=EXCLUDED.titulo, descripcion=EXCLUDED.descripcion,
           price=EXCLUDED.price, visibility=EXCLUDED.visibility, subscribers=EXCLUDED.subscribers`,
        [
          id, obj["titulo"]||id, obj["descripcion"]||"",
          parseInt(obj["createdBy"]||"0", 10) || null,
          obj["price"]||"", obj["visibility"]||"private",
          parseInt(obj["subscribers"]||"0", 10) || 0
        ]
      );
      count++;
    }
    console.log(`   ✅ ${count} estrategias migradas.`);
  } catch (e) {
    console.warn("   ⚠️  No se pudieron migrar estrategias (hoja puede estar vacía):", (e as Error).message);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n🚀 MIGRACIÓN Sheet → PostgreSQL\n");
  const doc = new GoogleSpreadsheet(SHEET_ID!, getAuth());
  const client = await pool.connect();
  
  try {
    await client.query("BEGIN");
    
    await migratePlans(doc, client);
    const userMenusMap = await migrateUsers(doc, client);
    await migrateUserMenus(userMenusMap, client);
    await migrateStrategies(doc, client);
    
    await client.query("COMMIT");
    console.log("\n✅ MIGRACIÓN COMPLETADA EXITOSAMENTE\n");
    console.log("Próximo paso: levantar docker compose con DATABASE_URL activo.");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("\n❌ MIGRACIÓN FALLIDA — ROLLBACK ejecutado:", e);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(e => { console.error(e); process.exit(1); });
