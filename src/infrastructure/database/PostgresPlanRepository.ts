import { getDbPool } from "./PostgresConnection.js";
import { IPlanRepository } from "../../domain/interfaces/IPlanRepository.js";
import { Plan } from "../../domain/models/Plan.js";
import type { PlanRow } from "../../user-config.js";

export class PostgresPlanRepository implements IPlanRepository {
  async getPlans(): Promise<Plan[]> {
    const pool = getDbPool();
    try {
      const { rows } = await pool.query(
        "SELECT id, title, description, price, menu_ids, price_1m, price_3m, price_6m, price_9m, price_1a, auto_approve FROM plans ORDER BY id ASC"
      );
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        description: r.description ?? "",
        price: r.price ?? "",
        menuIds: r.menu_ids ?? "",
        price_1m: r.price_1m ?? "",
        price_3m: r.price_3m ?? "",
        price_6m: r.price_6m ?? "",
        price_9m: r.price_9m ?? "",
        price_1a: r.price_1a ?? "",
        autoApprove: r.auto_approve ?? false,
      }));
    } catch (e) {
      console.error("[PostgresPlanRepository] Error loading plans:", e);
      return [];
    }
  }

  async getPlanById(id: string): Promise<Plan | null> {
    const plans = await this.getPlans();
    return plans.find((p) => p.id === id) ?? null;
  }

  async getPlanByTitle(title: string): Promise<Plan | null> {
    const plans = await this.getPlans();
    return plans.find((p) => p.title.toLowerCase() === title.toLowerCase()) ?? null;
  }

  async savePlans(plans: Plan[]): Promise<void> {
    const pool = getDbPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const p of plans) {
        await client.query(
          `INSERT INTO plans (id, title, description, price, menu_ids, price_1m, price_3m, price_6m, price_9m, price_1a, auto_approve, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
           ON CONFLICT (id) DO UPDATE SET
             title=EXCLUDED.title, description=EXCLUDED.description, price=EXCLUDED.price,
             menu_ids=EXCLUDED.menu_ids, price_1m=EXCLUDED.price_1m, price_3m=EXCLUDED.price_3m,
             price_6m=EXCLUDED.price_6m, price_9m=EXCLUDED.price_9m, price_1a=EXCLUDED.price_1a,
             auto_approve=EXCLUDED.auto_approve, updated_at=NOW()`,
          [p.id, p.title, p.description ?? "", p.price ?? "", p.menuIds ?? "",
           p.price_1m ?? "", p.price_3m ?? "", p.price_6m ?? "", p.price_9m ?? "", p.price_1a ?? "",
           p.autoApprove ?? false]
        );
      }
      await client.query("COMMIT");
      console.log("[PostgresPlanRepository] Saved", plans.length, "plans.");
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[PostgresPlanRepository] Error saving plans:", e);
    } finally {
      client.release();
    }
  }
}

// ─── Functional interface (for use in user-config.ts guards) ─────────────────

export async function loadPlansFromPG(): Promise<PlanRow[]> {
  const repo = new PostgresPlanRepository();
  const plans = await repo.getPlans();
  return plans.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    price: p.price,
    menuIds: p.menuIds,
    price_1m: p.price_1m,
    price_3m: p.price_3m,
    price_6m: p.price_6m,
    price_9m: p.price_9m,
    price_1a: p.price_1a,
    autoApprove: p.autoApprove ? "true" : "",
  }));
}

export async function savePlansToPG(items: PlanRow[]): Promise<void> {
  const repo = new PostgresPlanRepository();
  await repo.savePlans(items.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    price: r.price,
    menuIds: r.menuIds,
    price_1m: r.price_1m,
    price_3m: r.price_3m,
    price_6m: r.price_6m,
    price_9m: r.price_9m,
    price_1a: r.price_1a,
    autoApprove: r.autoApprove === "true",
  })));
}
