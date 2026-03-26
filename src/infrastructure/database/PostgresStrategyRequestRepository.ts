import { getDbPool } from "./PostgresConnection.js";

// strategy_requests schema: id SERIAL, user_id BIGINT, menu_id VARCHAR, requested_at BIGINT, UNIQUE(user_id, menu_id)

export interface StrategyRequestPG {
  userId: number;
  menuId: string;
  requestedAt: number;
}

export async function loadStrategyRequestsFromPG(): Promise<StrategyRequestPG[]> {
  const pool = getDbPool();
  try {
    const { rows } = await pool.query(
      "SELECT user_id, menu_id, requested_at FROM strategy_requests ORDER BY requested_at ASC"
    );
    return rows.map((r) => ({
      userId: Number(r.user_id),
      menuId: r.menu_id,
      requestedAt: Number(r.requested_at),
    }));
  } catch (e) {
    console.error("[PostgresStrategyRequestRepository] Error loading:", e);
    return [];
  }
}

export async function addStrategyRequestToPG(userId: number, menuId: string): Promise<boolean> {
  const pool = getDbPool();
  try {
    const { rowCount } = await pool.query(
      `INSERT INTO strategy_requests (user_id, menu_id, requested_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, menu_id) DO NOTHING`,
      [userId, menuId, BigInt(Date.now())]
    );
    return (rowCount ?? 0) > 0;
  } catch (e) {
    console.error("[PostgresStrategyRequestRepository] Error adding:", e);
    return false;
  }
}

export async function removeStrategyRequestFromPG(userId: number, menuId: string): Promise<boolean> {
  const pool = getDbPool();
  try {
    const { rowCount } = await pool.query(
      "DELETE FROM strategy_requests WHERE user_id=$1 AND menu_id=$2",
      [userId, menuId]
    );
    return (rowCount ?? 0) > 0;
  } catch (e) {
    console.error("[PostgresStrategyRequestRepository] Error removing:", e);
    return false;
  }
}
