#!/usr/bin/env node
// Runs the two board proofs that need no proof API key against the local API, Sync and web build of a pull request.
// Run it through apps/web/tests/dashboard/real-engine.sh, which owns Postgres, Redis and the API. The deployed
// proof (pnpm web:proof) still runs the board proof that joins an SDK guest, in the nightly cut.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboardProofFixture } from "../../apps/web/tests/dashboard/browser-fixture.mjs";

const boardTests = ["the live board keeps its canvas and drawing coordinates", "whiteboard keeps local zoom with desktop teacher and phone follower"];

process.env.VITE_CHALK_HELPER_INSTALL_URL = "https://example.com/chalk-helper";
const { origin, repository, context, runOwned, cleanup } = await createDashboardProofFixture();
const privateDir = await mkdtemp(join(tmpdir(), "chalk-annotation-proof-"));
const ownerState = join(privateDir, "owner.json");
// The public Space page creates its Space in the managed Tenant that real-engine.sh names; the dashboard fixture makes its own Tenant, so this one is added.
const managedTenant = process.env.CHALK_PUBLIC_INVITE_MANAGED_TENANT_ID;
execFileSync("psql", [process.env.CHALK_DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-qAtc", `insert into tenants (id, name) values ('${managedTenant}', 'Managed public Tenant') on conflict do nothing; insert into tenant_artifact_policies (tenant_id) values ('${managedTenant}') on conflict do nothing`]);
let code = 1;
try {
  const env = { CHALK_PROOF_WEB_URL: origin, E2E_TELEMETRY_DISABLED: "1" };
  code = process.argv.includes("--annotation-only") ? 0 : await runOwned("pnpm", ["exec", "e2e", "run", "tests/board.e2e.ts", ...boardTests.flatMap((title) => ["--grep", title])], repository, env);
  if (code === 0) {
    execFileSync("psql", [process.env.CHALK_DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-qAtc", "insert into screen_annotation_settings (enabled) values (true) on conflict (singleton) do update set enabled = excluded.enabled"]);
    await context.storageState({ path: ownerState });
    code = await runOwned("pnpm", ["exec", "e2e", "run", "--config", "apps/web/e2e.annotation.config.ts", "--grep", "live annotation"], repository, { ...env, CHALK_ANNOTATION_WEB_URL: origin, CHALK_ANNOTATION_OWNER_STATE: ownerState });
  }
  if (code !== 0) spawnSync("tail", ["-n", "40", "artifacts/dashboard-api.log"], { stdio: "inherit" });
} finally {
  await rm(privateDir, { recursive: true, force: true });
  await cleanup();
}
process.exitCode = code ?? 1;
