import { getDbPool } from "./PostgresConnection.js";
import type { UsersConfig, UserInfo, PlanRequest } from "../../user-config.js";

export async function loadUsersFromPG(): Promise<UsersConfig> {
  const pool = getDbPool();
  const config: UsersConfig = { allowed: [], menus: {}, userInfo: {}, requestedPlans: {} };
  
  // 1. Cargar Usuarios
  const { rows: users } = await pool.query("SELECT * FROM users");
  for (const u of users) {
    const uidStr = u.id.toString();
    const uid = Number(uidStr);
    
    if (u.plan_status === "requested") {
      config.requestedPlans[uidStr] = {
        plan: u.plan_id || "—",
        name: u.username || undefined,
        phone: u.phone || undefined,
        temporality: u.plan_temporality || undefined,
        expiry: u.plan_expiry || undefined,
      };
      continue;
    }
    
    if (u.plan_status === "rejected") {
      config.userInfo[uidStr] = {
        name: u.username || undefined,
        phone: u.phone || undefined,
        plan: u.plan_id || undefined,
        plan_status: "rejected",
        pending_plan: u.pending_plan || undefined,
        plan_temporality: u.plan_temporality || undefined,
        plan_expiry: u.plan_expiry || undefined,
        trial_used: u.trial_used || undefined,
        role: u.role || undefined
      };
      continue;
    }
    
    // Solo los usuarios explícitamente aprobados obtienen acceso completo (allowed)
    if (u.plan_status === "approved" && !config.allowed.includes(uid)) {
      config.allowed.push(uid);
    }
    config.userInfo[uidStr] = {
      name: u.username || undefined,
      phone: u.phone || undefined,
      plan: u.plan_id || undefined,
      plan_status: u.plan_status || undefined,
      pending_plan: u.pending_plan || undefined,
      plan_temporality: u.plan_temporality || undefined,
      plan_expiry: u.plan_expiry || undefined,
      trial_used: u.trial_used || undefined,
      role: u.role || "user"
    };
  }

  // 2. Cargar Menús (Estrategias) por usuario
  const { rows: userMenus } = await pool.query("SELECT user_id, menu_id FROM user_menus");
  for (const um of userMenus) {
    const uidStr = um.user_id.toString();
    if (!config.menus[uidStr]) config.menus[uidStr] = [];
    config.menus[uidStr].push(um.menu_id);
  }

  return config;
}

export async function persistUsersToPG(config: UsersConfig): Promise<void> {
  const pool = getDbPool();
  // Para evitar bloqueos, hacemos UPSERT o bulk logic.
  // Dado que persist() de config es una re-creación (similar a Google Sheets),
  // y para no destruir los referidos o históricos, haremos un UPSERT por fila.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    
    // Iterar requests
    for (const [uidStr, req] of Object.entries(config.requestedPlans) as [string, PlanRequest][]) {
      const uId = Number(uidStr);
      await client.query(
        `INSERT INTO users (id, username, phone, plan_id, plan_status, plan_temporality, plan_expiry)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (id) DO UPDATE SET 
           username = EXCLUDED.username,
           phone = EXCLUDED.phone,
           plan_id = EXCLUDED.plan_id,
           plan_status = EXCLUDED.plan_status,
           plan_temporality = EXCLUDED.plan_temporality,
           plan_expiry = EXCLUDED.plan_expiry`,
        [uId, req.name, req.phone, req.plan, "requested", req.temporality, req.expiry]
      );
    }

    // Iterar userInfo
    for (const [uidStr, info] of Object.entries(config.userInfo) as [string, UserInfo][]) {
      const uId = Number(uidStr);
      await client.query(
        `INSERT INTO users (id, username, phone, plan_id, plan_status, pending_plan, plan_temporality, plan_expiry, trial_used, role)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (id) DO UPDATE SET 
           username = EXCLUDED.username,
           phone = EXCLUDED.phone,
           plan_id = EXCLUDED.plan_id,
           plan_status = EXCLUDED.plan_status,
           pending_plan = EXCLUDED.pending_plan,
           plan_temporality = EXCLUDED.plan_temporality,
           plan_expiry = EXCLUDED.plan_expiry,
           trial_used = EXCLUDED.trial_used,
           role = EXCLUDED.role`,
        [
          uId, info.name, info.phone, info.plan, 
          info.plan_status || (config.allowed.includes(uId) ? "approved" : null), 
          info.pending_plan, info.plan_temporality, info.plan_expiry, 
          info.trial_used || false, info.role || "user"
        ]
      );
    }

    // Garantizar que TODOS los usuarios de config.allowed existan en la tabla users
    // (algunos están en allowed + menus pero no en userInfo, causando FK violation)
    for (const uid of config.allowed) {
      if (!config.userInfo[uid.toString()] && !config.requestedPlans[uid.toString()]) {
        await client.query(
          `INSERT INTO users (id, plan_status, role) VALUES ($1, 'approved', 'user')
           ON CONFLICT (id) DO NOTHING`,
          [uid]
        );
      }
    }

    // Sincronización diff-based de menús: solo borra los eliminados, añade los nuevos.
    // NO hace DELETE global para proteger contra escrituras concurrentes.
    const currentMenusRes = await client.query("SELECT user_id, menu_id FROM user_menus");
    const currentSet = new Set(currentMenusRes.rows.map((r: {user_id: number, menu_id: string}) => `${r.user_id}:${r.menu_id}`));
    
    const desiredSet = new Set<string>();
    for (const [uidStr, menus] of Object.entries(config.menus) as [string, string[]][]) {
      const uId = Number(uidStr);
      for (const menuId of menus) {
        desiredSet.add(`${uId}:${menuId}`);
      }
    }

    // Insertar los que faltan
    for (const key of desiredSet) {
      if (!currentSet.has(key)) {
        const [uId, menuId] = key.split(":");
        await client.query(
          `INSERT INTO user_menus (user_id, menu_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [Number(uId), menuId]
        );
      }
    }

    // Borrar solo los que ya no están en la config deseada
    for (const key of currentSet) {
      if (!desiredSet.has(key)) {
        const [uId, menuId] = key.split(":");
        await client.query(
          `DELETE FROM user_menus WHERE user_id = $1 AND menu_id = $2`,
          [Number(uId), menuId]
        );
      }
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[PostgresUserSync] Error al persistir:", e);
    throw e;
  } finally {
    client.release();
  }
}
