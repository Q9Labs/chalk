#!/usr/bin/env node
// Runs the two board proofs that need no proof API key against the local API, Sync and web build of a pull request.
// Run it through apps/web/tests/dashboard/real-engine.sh, which owns Postgres, Redis and the API. The deployed
// proof (pnpm web:proof) still runs the board proof that joins an SDK guest, in the nightly cut.
import { execFileSync, spawnSync } from "node:child_process";
import { createDashboardProofFixture } from "../../apps/web/tests/dashboard/browser-fixture.mjs";

const boardTests = ["the live board keeps its canvas and drawing coordinates", "whiteboard keeps local zoom with desktop teacher and phone follower"];

const { origin, repository, runOwned, cleanup } = await createDashboardProofFixture();
// The public Space page creates its Space in the managed Tenant that real-engine.sh names; the dashboard fixture makes its own Tenant, so this one is added.
const managedTenant = process.env.CHALK_PUBLIC_INVITE_MANAGED_TENANT_ID;
execFileSync("psql", [process.env.CHALK_DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-qAtc", `insert into tenants (id, name) values ('${managedTenant}', 'Managed public Tenant') on conflict do nothing; insert into tenant_artifact_policies (tenant_id) values ('${managedTenant}') on conflict do nothing`]);
let code = 1;
try {
  code = await runOwned("pnpm", ["exec", "e2e", "run", "tests/board.e2e.ts", ...boardTests.flatMap((title) => ["--grep", title])], repository, { CHALK_PROOF_WEB_URL: origin, E2E_TELEMETRY_DISABLED: "1" });
  if (code !== 0) spawnSync("tail", ["-n", "40", "artifacts/dashboard-api.log"], { stdio: "inherit" });
} finally {
  await cleanup();
}
process.exitCode = code ?? 1;
