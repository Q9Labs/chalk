import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createGatePlan } from "../../../../scripts/gates/chalk-gate-plan.mjs";

const script = new URL("./nightly-current-cut.sh", import.meta.url).pathname;
const thisCut = { sha: "aaa", run: "100" };

function deployment(sha, run, proof) {
  return { task: "nightly-cut", sha, payload: { proof_run_id: run, proof_result: proof } };
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
    encoding: "utf8",
  });
  return result.status === 0;
}

test("the newest cut that passed its proof is current", () => {
  assert.equal(cutIsCurrent([deployment("aaa", "100", "passed")]), true);
});

test("a newer host proof does not hide the current passing cut", () => {
  const deployments = [
    { task: "nightly-host-proof", sha: "aaa", payload: {} },
    deployment("aaa", "100", "passed"),
  ];
  const bin = mkdtempSync(join(tmpdir(), "current-cut-"));
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(deployments)}\nJSON\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const result = spawnSync("bash", ["-c", `source "${script}"; current_cut_sha_for_run`], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Q9Labs/chalk",
      SOURCE_RUN: "100",
      SOURCE_SHA: "aaa",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "aaa");
});

test("a failed deployment lookup fails instead of silently skipping the upload", () => {
  const bin = mkdtempSync(join(tmpdir(), "current-cut-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 22\n");
  chmodSync(join(bin, "gh"), 0o755);
  const result = spawnSync("bash", ["-c", `source "${script}"; current_cut_sha_for_run`], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REPOSITORY: "Q9Labs/chalk",
      SOURCE_RUN: "100",
      SOURCE_SHA: "aaa",
    },
    encoding: "utf8",
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 22);
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

test("both nightly publishers use the shared guard and carry no query of their own", () => {
  for (const name of ["publish-nightly-android.sh", "publish-nightly-ios.sh"]) {
    const source = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    assert.match(source, /source "\$repo_root\/apps\/mobile\/scripts\/release\/nightly-current-cut\.sh"/, name);
    assert.match(source, /cut_is_current \|\|/, name);
    assert.doesNotMatch(source, /deployments\?environment=nightly&task=nightly-cut&per_page=1"/, name);
  }
});
