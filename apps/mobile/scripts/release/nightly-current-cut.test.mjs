import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatePlan } from "../../../../scripts/gates/chalk-gate-plan.mjs";

const script = new URL("./nightly-current-cut.sh", import.meta.url).pathname;
const thisCut = { sha: "aaa", run: "100" };

function deployment(sha, run, proof) {
  return { sha, payload: { proof_run_id: run, proof_result: proof } };
}

// The deployments list is newest first, like the GitHub API returns it.
function cutIsCurrent(deployments, cut = thisCut) {
  const bin = mkdtempSync(join(tmpdir(), "current-cut-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(deployments)}\nJSON\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const result = spawnSync("bash", ["-c", `source "${script}"; cut_is_current`], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Q9Labs/chalk",
      SOURCE_RUN: cut.run,
      SOURCE_SHA: cut.sha,
    },
  });
  return result.status === 0;
}

test("the newest cut that passed its proof is current", () => {
  assert.equal(cutIsCurrent([deployment("aaa", "100", "passed")]), true);
});

test("a newer cut that failed its proof does not make the build stale", () => {
  assert.equal(cutIsCurrent([deployment("bbb", "101", "failed"), deployment("aaa", "100", "passed")]), true);
});

test("a newer cut that passed its proof makes the build stale", () => {
  assert.equal(cutIsCurrent([deployment("bbb", "101", "passed"), deployment("aaa", "100", "passed")]), false);
});

test("a cut whose own proof failed is not current", () => {
  assert.equal(cutIsCurrent([deployment("aaa", "100", "failed")]), false);
});

test("the failed Android publish of 2026-11-15 would have published", () => {
  // The two newest nightly-cut deployments when run 43690022203 refused: a cut whose proof failed, then the cut being published.
  const observed = [deployment("dfaa8e6023a86a17c7b8602b62933738efc68ef1", "43688458706", "failed"), deployment("8613646804c87f9a810c11ef9b57e9d5df0b7d18", "43687016274", "passed")];
  assert.equal(cutIsCurrent(observed, { sha: "8613646804c87f9a810c11ef9b57e9d5df0b7d18", run: "43687016274" }), true);
});

test("a change to only the guard or only its test selects the workflow-graph lane", () => {
  for (const file of ["apps/mobile/scripts/release/nightly-current-cut.sh", "apps/mobile/scripts/release/nightly-current-cut.test.mjs"]) {
    const plan = createGatePlan([file], { scope: "merge base to HEAD", services: "external", event: "pull_request" });
    assert.ok(plan.tasks.find((task) => task.id === "workflow-graph").selected, file);
  }
});
