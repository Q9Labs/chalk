import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { SCORECARD_SCHEMA } from "./schema.mjs";

const script = resolve(import.meta.dirname, "nightly.sh");
const root = resolve(import.meta.dirname, "../..");

// A fake `gh` records its calls and reports the open regression issue named by FAKE_OPEN_ISSUE.
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "scorecard-nightly-"));
  const remote = join(dir, "remote.git");
  execFileSync("git", ["init", "--quiet", "--bare", remote]);
  const bin = join(dir, "bin");
  execFileSync("mkdir", [bin]);
  const gh = join(bin, "gh");
  writeFileSync(gh, `#!/usr/bin/env bash\necho "$*" >> "${dir}/gh.log"\nif [[ "$1 $2" == "issue list" ]]; then echo "\${FAKE_OPEN_ISSUE:-}"; fi\n`);
  chmodSync(gh, 0o755);
  return { dir, remote, bin };
}

function card(day, leaveMs, passRate = 1) {
  return {
    schema: SCORECARD_SCHEMA,
    run: { id: `run-${day}`, commit: "c".repeat(40), tier: "nightly", environment: "staging", startedAt: `2026-11-${String(day).padStart(2, "0")}T03:00:00.000Z`, client: { kind: "browser", browser: "none", region: "github-hosted", size: "ubuntu-24.04" } },
    mediaPlane: "chalk_sfu",
    metrics: [
      { id: "proof.leave_median_ms", unit: "ms", n: 10, p50: leaveMs, p95: leaveMs, source: "leave-proof" },
      { id: "sfu.loopback.pass", unit: "pass", n: 4, p50: passRate, p95: passRate, source: "go-test" },
    ],
    dropped: [],
  };
}

function night(env, day, leaveMs, { open = "", passRate = 1 } = {}) {
  const file = join(env.dir, `card-${day}.json`);
  writeFileSync(file, JSON.stringify(card(day, leaveMs, passRate)));
  const summary = join(env.dir, "summary.md");
  const result = spawnSync("bash", [script, file], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${env.bin}:${process.env.PATH}`, SCORECARD_HISTORY_REMOTE: env.remote, GH_TOKEN: "x", GITHUB_REPOSITORY: "Q9Labs/chalk", GITHUB_STEP_SUMMARY: summary, GITHUB_RUN_ID: String(day), GITHUB_SERVER_URL: "https://github.com", FAKE_OPEN_ISSUE: open },
  });
  assert.equal(result.status, 0, result.stderr);
  return readFileSync(join(env.dir, "gh.log"), "utf8").split("\n").filter(Boolean);
}

const historyIds = (env) =>
  execFileSync("git", ["--git-dir", env.remote, "show", "scorecard-history:history.jsonl"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line).run.id);

test("a nightly run creates the history branch and, within budget, opens no issue", () => {
  const env = setup();
  night(env, 1, 900);
  night(env, 2, 950);
  assert.deepEqual(historyIds(env), ["run-1", "run-2"]);
  const trends = execFileSync("git", ["--git-dir", env.remote, "show", "scorecard-history:TRENDS.md"], { encoding: "utf8" });
  assert.match(trends, /proof\.leave_median_ms/);
});

test("a gated metric over its budget opens one issue, updates it while it lasts, and a good run closes it", () => {
  const env = setup();
  const opened = night(env, 1, 900, { passRate: 0.5 });
  assert.equal(opened.filter((call) => call.startsWith("issue create")).length, 1);
  const kept = night(env, 2, 900, { passRate: 0.5, open: "17" });
  assert.ok(kept.some((call) => call.startsWith("issue edit 17")));
  const closed = night(env, 3, 900, { open: "17" });
  assert.ok(closed.some((call) => call.startsWith("issue close 17")));
});

test("a warning-only metric over its budget opens no issue", () => {
  const env = setup();
  const calls = night(env, 1, 99_000);
  assert.equal(calls.filter((call) => call.startsWith("issue create")).length, 0);
});
