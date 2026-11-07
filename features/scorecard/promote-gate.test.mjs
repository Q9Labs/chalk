import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SCORECARD_SCHEMA } from "./schema.mjs";

const root = resolve(import.meta.dirname, "../..");
const script = resolve(import.meta.dirname, "promote-gate.sh");

// A fake `gh` records its calls and reports the open regression issue named by FAKE_OPEN_ISSUE.
function gate(mode, { passRate = 1, override = "", open = "" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "scorecard-promote-"));
  const remote = join(dir, "remote.git");
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/usr/bin/env bash\necho "$*" >> "${dir}/gh.log"\nif [[ "$1 $2" == "issue list" ]]; then echo "\${FAKE_OPEN_ISSUE:-}"; fi\n`);
  chmodSync(join(bin, "gh"), 0o755);
  const card = join(dir, "card.json");
  writeFileSync(
    card,
    JSON.stringify({
      schema: SCORECARD_SCHEMA,
      run: { id: "1-1", commit: "d".repeat(40), tier: "promote", environment: "production", startedAt: "2026-11-07T03:00:00.000Z", client: { kind: "browser", browser: "none", region: "github-hosted", size: "ubuntu-24.04" } },
      mediaPlane: "chalk_sfu",
      metrics: [{ id: "sfu.loopback.pass", unit: "pass", n: 4, p50: passRate, p95: passRate, source: "go-test" }],
      dropped: [],
    }),
  );
  const output = join(dir, "output");
  writeFileSync(output, "");
  const result = spawnSync("bash", [script, mode, card], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      SCORECARD_HISTORY_REMOTE: remote,
      SCORECARD_OVERRIDE: override,
      GH_TOKEN: "x",
      GITHUB_REPOSITORY: "Q9Labs/chalk",
      GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
      GITHUB_OUTPUT: output,
      GITHUB_RUN_ID: "9",
      GITHUB_SERVER_URL: "https://github.com",
      FAKE_OPEN_ISSUE: open,
    },
  });
  const calls = readFileSync(join(dir, "gh.log"), "utf8").split("\n").filter(Boolean);
  return { status: result.status, stderr: result.stderr, output: readFileSync(output, "utf8").trim(), calls, summary: readFileSync(join(dir, "summary.md"), "utf8") };
}

test("the first pass asks for a rerun when a gated metric is over its budget, and never fails", () => {
  const run = gate("first", { passRate: 0.5 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.output, "over=true");
  const clean = gate("first");
  assert.equal(clean.output, "over=false");
});

test("the rerun fails the run and opens one issue when the gated metric is still over its budget", () => {
  const run = gate("final", { passRate: 0.5 });
  assert.equal(run.status, 1);
  assert.equal(run.calls.filter((call) => call.startsWith("issue create")).length, 1);
  const known = gate("final", { passRate: 0.5, open: "17" });
  assert.ok(known.calls.some((call) => call.startsWith("issue comment 17")));
  assert.equal(gate("final").status, 0);
});

test("an override records its reason in the summary and on the open issue, and never blocks", () => {
  const first = gate("first", { passRate: 0.5, override: "known staging noise", open: "17" });
  assert.equal(first.status, 0);
  assert.equal(first.output, "over=false");
  assert.match(first.summary, /known staging noise/);
  assert.ok(first.calls.some((call) => call.startsWith("issue comment 17") && call.includes("known staging noise")));
  assert.equal(gate("final", { passRate: 0.5, override: "known staging noise" }).status, 0);
});

test("only the scorecard jobs of promote.yml refer to the scorecard, so a failed scorecard cannot start rollback", () => {
  const workflow = readFileSync(join(root, ".github/workflows/promote.yml"), "utf8");
  const jobs = workflow.split(/\n(?=  [a-z-]+:\n)/).slice(1);
  for (const job of jobs) {
    const name = job.match(/^ {2}([a-z-]+):/)[1];
    if (name.startsWith("scorecard")) continue;
    assert.doesNotMatch(job, /scorecard/, `job ${name} must not need or read a scorecard job`);
  }
});
