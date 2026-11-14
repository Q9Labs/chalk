import { setTimeout as delay } from "node:timers/promises";
import { startHarness } from "./e2e-harness.mjs";
import { signInChecks } from "./e2e-sign-in.mjs";
import { ownerChecks } from "./e2e-owner.mjs";
import { keyChecks, knockChecks, webhookChecks } from "./e2e-developer.mjs";
import { historyChecks, transcriptChecks } from "./e2e-history.mjs";
import { endChecks, homeChecks } from "./e2e-isolation.mjs";

// Each part reads what earlier parts left in `state` and returns what later parts need.
const PARTS = [signInChecks, ownerChecks, knockChecks, keyChecks, webhookChecks, historyChecks, transcriptChecks, homeChecks, endChecks];

async function refreshCostRun(h) {
  const { refreshCost } = await import("./refresh-cost.mjs");
  const client = h.browser();
  const session = await h.signIn(client, "ada");
  await refreshCost({ client, session, post: h.post, origin: h.origin, engineReads: h.engineReads, engineRequests: h.engineRequests, tenantId: (await h.tenantFor("ada")).id, sql: h.sql });
}

const h = await startHarness();
try {
  if (process.env.DASHBOARD_REFRESH_COST === "1") {
    await refreshCostRun(h);
  } else {
    const state = {};
    for (const part of PARTS) Object.assign(state, await part(h, state));
  }
} catch (error) {
  await delay(200);
  console.error(h.output().slice(-8000));
  throw error;
} finally {
  await h.stop();
}
