import { runStrategy } from "./src/strategies/index.ts";
async function main() {
  const map = {
    "12/01/24": { m: [1,2,3], e: [4,5,6] },
    "12/02/24": { m: [7,8,9], e: [0,1,2] }
  };
  const res = await runStrategy("max_per_week_day", { mapSource: "p3", period: "m" }, {
    getP3Map: async () => map,
    getP4Map: async () => map,
  } as any);
  console.log("FINAL OUTPUT:");
  console.log(res);
}
main().catch(console.error);
