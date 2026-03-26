import { getDbPool } from "./PostgresConnection.js";
import type { PaymentMethod } from "../../payment-methods.js";

// payment_methods schema: id SERIAL, name VARCHAR, details TEXT
// Mapping: name = pm_xxx string ID, details = JSON {description, account, currency}

function rowToPM(r: { id: number; name: string; details: string }): PaymentMethod {
  try {
    const d = JSON.parse(r.details) as { description?: string; account?: string; currency?: string };
    return {
      id: r.name,
      description: d.description ?? "",
      account: d.account ?? "",
      currency: d.currency ?? "",
    };
  } catch {
    return { id: r.name, description: r.details ?? "", account: "", currency: "" };
  }
}

export async function loadPaymentMethodsFromPG(): Promise<PaymentMethod[]> {
  const pool = getDbPool();
  try {
    const { rows } = await pool.query("SELECT id, name, details FROM payment_methods ORDER BY id ASC");
    return rows.map(rowToPM);
  } catch (e) {
    console.error("[PostgresPaymentMethodRepository] Error loading:", e);
    return [];
  }
}

export async function savePaymentMethodsToPG(items: PaymentMethod[]): Promise<void> {
  const pool = getDbPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM payment_methods");
    for (const pm of items) {
      const details = JSON.stringify({ description: pm.description, account: pm.account, currency: pm.currency });
      await client.query(
        "INSERT INTO payment_methods (name, details) VALUES ($1, $2)",
        [pm.id, details]
      );
    }
    await client.query("COMMIT");
    console.log("[PostgresPaymentMethodRepository] Saved", items.length, "payment methods.");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[PostgresPaymentMethodRepository] Error saving:", e);
    throw e;
  } finally {
    client.release();
  }
}
