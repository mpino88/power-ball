import { unodostresPlus } from "./strategies/unodostres-plus.js";
import { parseStrategyContextCallback } from "./strategies/types.js";

// Datos de prueba donde algunos números salen en 'm' y otros en 'e' en el mismo día
const mockMap = {
  "01/01/24": { m: [1, 2, 3], e: [4, 5, 6] },
  "01/02/24": { m: [7, 8, 9], e: [1, 2, 3] },
  "01/03/24": { m: [4, 5, 6], e: [7, 8, 9] },
};

async function testPlus() {
  console.log("=== Probando parseStrategyContextCallback ===");
  const parsed = parseStrategyContextCallback("strat_unodostres_plus_p3_a");
  console.log(parsed);

  const context = parsed?.context;
  if (!context) throw new Error("Parse falló");
  
  // Asignamos límite 3 de prueba (al estilo de the bot handling this)
  context.params = { ...context.params, limit: 3 };

  console.log("\n=== Ejecutando UNODOSTRES+ con Ambos + limit 3 ===");
  const output = await unodostresPlus.run(context, mockMap);
  console.log(output);
}

testPlus().catch(console.error);
