import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createProfilePlan, executeProfile } from "./reliability_harness.mjs";

test("maps the three triggers to one harness with explicit profiles", () => {
  const output = "/tmp/chalk-reliability-test";
  const correctness = createProfilePlan("correctness", output);
  const topology = createProfilePlan("topology", output);
  const release = createProfilePlan("release", output);

  assert.deepEqual(
    correctness.map((step) => step.name),
    ["diagnostics_contracts_build", "sync_full_gate", "sync_v1_breaker", "sync_v1_replay", "typescript_sync_and_whiteboard", "whiteboard_collaboration"],
  );
  assert.deepEqual(correctness[0].command, ["pnpm", "--dir", "packages/diagnostics-contracts", "run", "build"]);
  assert.equal(correctness[1].env.TSX_TSCONFIG_PATH, undefined);
  assert.match(correctness[2].env.TSX_TSCONFIG_PATH, /apps\/sync\/scripts\/tsconfig\.wire-sdk\.json$/);
  assert.equal(correctness[3].env.TSX_TSCONFIG_PATH, correctness[2].env.TSX_TSCONFIG_PATH);
  const buildIndex = correctness.findIndex((step) => step.name === "diagnostics_contracts_build");
  for (const affectedStep of ["sync_v1_breaker", "sync_v1_replay"]) {
    assert.ok(buildIndex < correctness.findIndex((step) => step.name === affectedStep));
  }
  assert.deepEqual(
    topology.map((step) => step.name),
    ["sync_basic_gate", "multi_node_topology", "postgres_failover"],
  );
  assert.deepEqual(topology[1].command.slice(0, 3), ["mix", "test", "test/chalk_sync/reliability/topology_profile_test.exs"]);
  assert.deepEqual(topology[2].command.slice(0, 3), ["mix", "test", "test/chalk_sync/reliability/postgres_failover_profile_test.exs"]);
  assert.deepEqual(
    release.map((step) => step.name),
    ["correctness_profile", "topology_profile", "soak_and_load", "node_process_restart", "real_browser"],
  );
  assert.deepEqual(release[1].command, ["scripts/gates/with-sync-topology.sh", "--", "apps/sync/scripts/reliability-harness", "topology"]);
});

test("writes sealed per-commit evidence for a passing profile", (context) => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "chalk-reliability-pass-"));
  context.after(() => rmSync(outputRoot, { recursive: true }));
  const result = executeProfile({
    profile: "correctness",
    outputRoot,
    runId: "pass-run",
    gitSha: "a".repeat(40),
    worktreeFingerprint: "b".repeat(64),
    plan: [{ name: "proof", command: ["proof"], cwd: outputRoot, env: {} }],
    spawn: () => ({ status: 0, signal: null }),
    now: () => new Date("2026-07-30T12:00:00Z"),
  });

  assert.equal(result.status, 0);
  assert.equal(result.manifest.verdict, "pass");
  assert.equal(result.manifest.steps[0].status, "passed");
  assert.equal(statSync(path.join(result.runDirectory, "manifest.json")).mode & 0o777, 0o444);
});

test("fails closed, records the failed step, and stops the plan", (context) => {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "chalk-reliability-fail-"));
  context.after(() => rmSync(outputRoot, { recursive: true }));
  const launched = [];
  const result = executeProfile({
    profile: "topology",
    outputRoot,
    runId: "fail-run",
    gitSha: "a".repeat(40),
    worktreeFingerprint: "b".repeat(64),
    plan: [
      { name: "failure", command: ["failure"], cwd: outputRoot, env: {} },
      { name: "must_not_run", command: ["must-not-run"], cwd: outputRoot, env: {} },
    ],
    spawn: (command) => {
      launched.push(command);
      return { status: 7, signal: null };
    },
    now: () => new Date("2026-07-30T12:00:00Z"),
  });

  assert.equal(result.status, 7);
  assert.equal(result.manifest.verdict, "fail");
  assert.deepEqual(launched, ["failure"]);

  const manifest = JSON.parse(readFileSync(path.join(result.runDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.steps[0].exit_code, 7);
  assert.deepEqual(manifest.reproducer, ["apps/sync/scripts/reliability-harness", "topology"]);
});
