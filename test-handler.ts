import { handleMenuCallback } from "./src/menus/handlers.js";

async function run() {
  const deps: any = {
    getHotThresholdDays: () => 3,
    getP3Map: async () => ({}),
    getP4Map: async () => ({}),
  };
  const ctx: any = { from: { id: 1 } };
  
  const res = await handleMenuCallback(ctx, "menu_max_per_week_day", deps);
  console.log("Result for menu_max_per_week_day:", res);
  
  const res2 = await handleMenuCallback(ctx, "menu_fijo", deps);
  console.log("Result for menu_fijo:", res2 !== null);
}

run();
