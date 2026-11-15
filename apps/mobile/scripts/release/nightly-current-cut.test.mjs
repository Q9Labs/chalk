import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./nightly-current-cut.sh", import.meta.url).pathname;
const thisCut = { sha: "aaa", run: "100" };

function deployment(sha, run, proof) {
  return { sha, payload: { proof_run_id: run, proof_result: proof } };
}

// The deployments list is newest first, like the GitHub API returns it.
function cutIsCurrent(deployments) {
  const bin = mkdtempSync(join(tmpdir(), "current-cut-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(deployments)}\nJSON\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const result = spawnSync("bash", ["-c", `source "${script}"; cut_is_current`], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Q9Labs/chalk",
      SOURCE_RUN: thisCut.run,
      SOURCE_SHA: thisCut.sha,
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
