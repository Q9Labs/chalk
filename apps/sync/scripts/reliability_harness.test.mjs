import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { assertStopped, signalWhenReady, stubbornCommand } from "../../../scripts/gates/signal-test.mjs";
import { createProfilePlan, executeProfile } from "./reliability_harness.mjs";

test("maps the three triggers to one harness with explicit profiles", () => {
  const output = "/tmp/chalk-reliability-test";
  const correctness = createProfilePlan("correctness", output);
  const topology = createProfilePlan("topology", output);
  const release = createProfilePlan("release", output);

  assert.deepEqual(
    correctness.map((step) => step.name),
    ["sync_full_gate", "sync_v1_breaker", "sync_v1_replay", "typescript_sync_and_whiteboard", "whiteboard_collaboration"],
  );
  assert.equal(correctness[0].env.TSX_TSCONFIG_PATH, undefined);
  assert.match(correctness[1].env.TSX_TSCONFIG_PATH, /apps\/sync\/scripts\/tsconfig\.wire-sdk\.json$/);
  assert.equal(correctness[2].env.TSX_TSCONFIG_PATH, correctness[1].env.TSX_TSCONFIG_PATH);
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

function strictRoot(context) {
  const root = mkdtempSync(path.join(tmpdir(), "chalk-test-strict-signal-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "tmp"));
  const env = { ...process.env, PATH: `${root}:${process.env.PATH}`, TMPDIR: path.join(root, "tmp"), TEST_READY: path.join(root, "ready"), TEST_PIDS: path.join(root, "pids") };
  return { root, env };
}

test("strict Sync tests stopped with TERM exit 143 even when mix exits 0 on TERM", async (context) => {
  const { root, env } = strictRoot(context);
  // The BEAM shuts down cleanly with status 0 when it gets TERM.
  writeFileSync(path.join(root, "mix"), "#!/bin/bash\ntrap 'exit 0' TERM\ntouch \"$TEST_READY\"\nsleep 10 &\nwait\n", { mode: 0o755 });
  const stopped = await signalWhenReady(context, { args: [path.join(import.meta.dirname, "test-strict")], env, ready: env.TEST_READY, signal: "SIGTERM" });
  assert.deepEqual({ code: stopped.code, signal: stopped.signal }, { code: 143, signal: null });
});

test("strict Sync tests stop a mix that ignores TERM, remove their output and exit 143", async (context) => {
  const { root, env } = strictRoot(context);
  writeFileSync(path.join(root, "mix"), stubbornCommand, { mode: 0o755 });
  const stopped = await signalWhenReady(context, { args: [path.join(import.meta.dirname, "test-strict")], env: { ...env, CHALK_GATE_STOP_GRACE_SECONDS: "1" }, ready: env.TEST_READY, signal: "SIGTERM" });
  assert.deepEqual({ code: stopped.code, signal: stopped.signal }, { code: 143, signal: null });
  assert.ok(stopped.seconds < 2.5, `the wrapper took ${stopped.seconds} seconds to stop`);
  await assertStopped(readFileSync(env.TEST_PIDS, "utf8").trim().split(" ").map(Number));
  assert.deepEqual(readdirSync(env.TMPDIR), []);
  assert.match(stopped.stderr, /^test-strict: stopped by TERM after \d+s; it cleans up and exits 143$/mu);
  assert.match(stopped.stderr, /^test-strict: still running 1s after TERM, so it gets KILL$/mu);
});
