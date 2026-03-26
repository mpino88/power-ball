import { getDbPool } from "./PostgresConnection.js";
import { IStrategyRepository, CustomStrategy } from "../../domain/interfaces/IStrategyRepository.js";

export class PostgresStrategyRepository implements IStrategyRepository {
  async getCustomStrategies(): Promise<CustomStrategy[]> {
    const pool = getDbPool();
    try {
      const { rows } = await pool.query(
        "SELECT id, titulo, descripcion, created_by, price, visibility, subscribers FROM custom_strategies ORDER BY created_at ASC"
      );
      return rows.map((r) => ({
        id: r.id,
        titulo: r.titulo,
        descripcion: r.descripcion ?? undefined,
        createdBy: r.created_by ?? undefined,
        price: r.price ?? undefined,
        visibility: (r.visibility === "public" ? "public" : "private") as "public" | "private",
        subscribers: r.subscribers ?? 0,
      }));
    } catch (e) {
      console.error("[PostgresStrategyRepository] Error loading strategies:", e);
      return [];
    }
  }

  async saveCustomStrategies(strategies: CustomStrategy[]): Promise<void> {
    const pool = getDbPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM custom_strategies");
      for (const s of strategies) {
        await client.query(
          `INSERT INTO custom_strategies (id, titulo, descripcion, created_by, price, visibility, subscribers)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [s.id, s.titulo, s.descripcion ?? null, s.createdBy ?? null, s.price ?? null, s.visibility ?? "private", s.subscribers ?? 0]
        );
      }
      await client.query("COMMIT");
      console.log("[PostgresStrategyRepository] Saved", strategies.length, "strategies.");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[PostgresStrategyRepository] Error saving strategies:", e);
    } finally {
      client.release();
    }
  }
}

// ─── Functional interface (for use in user-config.ts guards) ─────────────────

export async function loadStrategiesFromPG(): Promise<import("../../user-config.js").StrategyRow[]> {
  const repo = new PostgresStrategyRepository();
  const rows = await repo.getCustomStrategies();
  return rows.map((r) => ({
    id: r.id,
    titulo: r.titulo,
    descripcion: r.descripcion,
    createdBy: r.createdBy,
    price: r.price,
    visibility: r.visibility,
    subscribers: r.subscribers,
  }));
}

export async function saveStrategiesToPG(items: import("../../user-config.js").StrategyRow[]): Promise<void> {
  const repo = new PostgresStrategyRepository();
  await repo.saveCustomStrategies(items.map((r) => ({
    id: r.id,
    titulo: r.titulo,
    descripcion: r.descripcion,
    createdBy: r.createdBy,
    price: r.price,
    visibility: (r.visibility === "public" ? "public" : "private") as "public" | "private",
    subscribers: r.subscribers,
  })));
}
