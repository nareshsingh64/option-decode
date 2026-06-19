import { buildDemoSnapshot, saveOptionChainSnapshot, seedDefaultPlans } from "./index.js";

const plans = await seedDefaultPlans();
const snapshotId = await saveOptionChainSnapshot(buildDemoSnapshot());

console.log(`Seeded ${plans.length} subscription plans`);
console.log(`Seeded demo option-chain snapshot ${snapshotId}`);
