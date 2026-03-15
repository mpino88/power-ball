import { loadPlansFromSheet } from "./src/user-config.js";
import 'dotenv/config';

async function main() {
  const plans = await loadPlansFromSheet();
  console.log(JSON.stringify(plans, null, 2));
}
main().catch(console.error);
