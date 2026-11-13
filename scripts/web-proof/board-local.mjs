#!/usr/bin/env node
// Runs the two board proofs that need no proof API key against the local API, Sync and web build of a pull request.
// Run it through apps/web/tests/dashboard/real-engine.sh, which owns Postgres, Redis and the API. The deployed
// proof (pnpm web:proof) still runs the board proof that joins an SDK guest, in the nightly cut.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createDashboardProofFixture } from "../../apps/web/tests/dashboard/browser-fixture.mjs";

const boardTests = ["the live board keeps its canvas and drawing coordinates", "whiteboard keeps local zoom with desktop teacher and phone follower"];

const { origin, cleanup } = await createDashboardProofFixture();
let code = 1;
try {
  const child = spawn("pnpm", ["exec", "e2e", "run", "tests/board.e2e.ts", ...boardTests.flatMap((title) => ["--grep", title])], {
    stdio: "inherit",
    env: { ...process.env, CHALK_PROOF_WEB_URL: origin, E2E_TELEMETRY_DISABLED: "1" },
  });
  [code] = await once(child, "exit");
} finally {
  await cleanup();
}
process.exitCode = code ?? 1;
