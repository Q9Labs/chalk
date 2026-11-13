#!/usr/bin/env node
// Runs the two board proofs that need no proof API key against the local API, Sync and web build of a pull request.
// Run it through apps/web/tests/dashboard/real-engine.sh, which owns Postgres, Redis and the API. The deployed
// proof (pnpm web:proof) still runs the board proof that joins an SDK guest, in the nightly cut.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createDashboardProofFixture } from "../../apps/web/tests/dashboard/browser-fixture.mjs";

const boardTests = ["the live board keeps its canvas and drawing coordinates", "whiteboard keeps local zoom with desktop teacher and phone follower"];

const { origin, cleanup } = await createDashboardProofFixture();
// The public Space page creates its Space in the managed Tenant that real-engine.sh names; the dashboard fixture makes its own Tenant, so this one is added.
const managedTenant = process.env.CHALK_PUBLIC_INVITE_MANAGED_TENANT_ID;
execFileSync("psql", [process.env.CHALK_DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-qAtc", `insert into tenants (id, name) values ('${managedTenant}', 'Managed public Tenant') on conflict do nothing`]);
console.log("managed tenants:", execFileSync("psql", [process.env.CHALK_DATABASE_URL, "-qAtc", "select id, name from tenants order by created_at"]).toString(), "api sees", managedTenant, "database", process.env.CHALK_DATABASE_URL?.replace(/:\/\/[^@]*@/, "://"));
let code = 1;
try {
  const child = spawn("pnpm", ["exec", "e2e", "run", "tests/board.e2e.ts", ...boardTests.flatMap((title) => ["--grep", title])], {
    stdio: "inherit",
    env: { ...process.env, CHALK_PROOF_WEB_URL: origin, E2E_TELEMETRY_DISABLED: "1" },
  });
  [code] = await once(child, "exit");
  if (code !== 0) spawnSync("tail", ["-n", "40", "artifacts/dashboard-api.log"], { stdio: "inherit" });
} finally {
  await cleanup();
}
process.exitCode = code ?? 1;
