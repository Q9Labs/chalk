#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const syncDirectory = path.join(repositoryRoot, "apps/sync");
const diagnosticsContractsTsconfig = path.join(repositoryRoot, "apps/sync/scripts/tsconfig.wire-sdk.json");
const evidenceKind = "chalk_sync_reliability_profile";
const schemaVersion = 1;
const profiles = new Set(["correctness", "topology", "release"]);

function step(name, command, options = {}) {
  return {
    name,
    command,
    cwd: options.cwd ?? repositoryRoot,
    env: options.env ?? {},
  };
}

export function createProfilePlan(profile, runDirectory) {
  if (!profiles.has(profile)) throw new Error(`unknown reliability profile: ${profile}`);

  const correctness = [
    step("diagnostics_contracts_build", ["pnpm", "--dir", "packages/diagnostics-contracts", "run", "build"]),
    step("sync_full_gate", ["apps/sync/scripts/gate.sh", "run"]),
    step("sync_v1_breaker", ["mix", "sync.breaker.v1", "--output", path.join(runDirectory, "sync-breaker-v1.json")], { cwd: syncDirectory, env: { MIX_ENV: "test", TSX_TSCONFIG_PATH: diagnosticsContractsTsconfig } }),
    step("sync_v1_replay", ["mix", "sync.breaker.v1", "--replay", path.join(runDirectory, "sync-breaker-v1.json")], { cwd: syncDirectory, env: { MIX_ENV: "test", TSX_TSCONFIG_PATH: diagnosticsContractsTsconfig } }),
    step("typescript_sync_and_whiteboard", ["pnpm", "--dir", "sdks/typescript/client", "exec", "vitest", "run", "src/sync", "src/whiteboard"]),
    step("whiteboard_collaboration", ["pnpm", "--dir", "packages/whiteboard", "exec", "vitest", "run", "src/collab", "src/embedded"]),
  ];

  if (profile === "correctness") return correctness;

  const topology = [
    step("sync_basic_gate", ["apps/sync/scripts/gate.sh", "basic"]),
    step("multi_node_topology", ["mix", "test", "test/chalk_sync/reliability/topology_profile_test.exs", "--include", "reliability_topology", "--max-cases", "1"], { cwd: syncDirectory, env: { MIX_ENV: "test" } }),
    step("postgres_failover", ["mix", "test", "test/chalk_sync/reliability/postgres_failover_profile_test.exs", "--include", "reliability_topology", "--max-cases", "1"], { cwd: syncDirectory, env: { MIX_ENV: "test" } }),
  ];

  if (profile === "topology") return topology;

  return [
    step("correctness_profile", ["apps/sync/scripts/with-reliability-postgres", "apps/sync/scripts/reliability-harness", "correctness"]),
    step("topology_profile", ["scripts/gates/with-sync-topology.sh", "--", "apps/sync/scripts/reliability-harness", "topology"]),
    step("soak_and_load", ["apps/sync/scripts/with-reliability-postgres", "apps/sync/scripts/reliability-soak"]),
    step("node_process_restart", ["apps/sync/scripts/with-reliability-postgres", "pnpm", "--dir", "sdks/typescript/client", "run", "test:sync-node-restart"]),
    step("real_browser", ["apps/sync/scripts/with-reliability-postgres", "pnpm", "--dir", "sdks/typescript/client", "run", "test:sync-browser"]),
  ];
}

function gitOutput(arguments_, options = {}) {
  return execFileSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: options.encoding ?? "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
}

function gitSha() {
  return gitOutput(["rev-parse", "HEAD"]).trim();
}

function relevantWorkingTreeFingerprint() {
  const scope = [
    ".github/workflows",
    "apps/api/migrations",
    "apps/sync",
    "package.json",
    "packages/whiteboard",
    "pnpm-lock.yaml",
    "scripts/gates",
    "sdks/typescript/client/package.json",
    "sdks/typescript/client/scripts/real-browser-sync.mjs",
    "sdks/typescript/client/scripts/real-node-restart-sync.mjs",
    "sdks/typescript/client/src/sync",
    "sdks/typescript/client/src/whiteboard",
  ];
  const digest = createHash("sha256");
  digest.update(gitOutput(["diff", "--binary", "HEAD", "--", ...scope]));

  const untracked = gitOutput(["ls-files", "--others", "--exclude-standard", "-z", "--", ...scope], {
    encoding: "buffer",
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .sort();

  for (const relativePath of untracked) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    const file = lstatSync(absolutePath);
    digest.update(relativePath);
    digest.update("\0");

    if (file.isSymbolicLink()) {
      digest.update("symlink\0");
      digest.update(readlinkSync(absolutePath));
    } else if (file.isFile()) {
      digest.update(readFileSync(absolutePath));
    } else {
      digest.update(`unsupported:${file.mode}`);
    }

    digest.update("\0");
  }

  return digest.digest("hex");
}

function runId(profile, now = new Date()) {
  return `${now.toISOString().replaceAll(/[-:.]/g, "")}-${process.pid}-${profile}`;
}

function defaultOutputRoot() {
  return path.join(syncDirectory, ".artifacts/reliability");
}

function writeManifest(runDirectory, manifest, final = false) {
  const destination = path.join(runDirectory, "manifest.json");
  const temporary = `${destination}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, destination);
  if (final) chmodSync(destination, 0o444);
}

function parseArguments(arguments_) {
  const [profile, ...remaining] = arguments_;
  const hasDefaultOutput = remaining.length === 0;
  const hasExplicitOutput = remaining.length === 2 && remaining[0] === "--output" && Boolean(remaining[1]);

  if (!profiles.has(profile) || (!hasDefaultOutput && !hasExplicitOutput)) {
    throw new Error("usage: reliability-harness <correctness|topology|release> [--output <dir>]");
  }

  return {
    profile,
    outputRoot: hasDefaultOutput ? defaultOutputRoot() : path.resolve(remaining[1]),
  };
}

function initializeRun(options) {
  const startedAt = options.now?.() ?? new Date();
  const id = options.runId ?? runId(options.profile, startedAt);
  const runDirectory = path.join(options.outputRoot, id);
  mkdirSync(options.outputRoot, { recursive: true, mode: 0o700 });
  mkdirSync(runDirectory, { recursive: false, mode: 0o700 });

  const manifest = {
    kind: evidenceKind,
    schema_version: schemaVersion,
    run_id: id,
    profile: options.profile,
    git_sha: options.gitSha ?? gitSha(),
    relevant_worktree_sha256: options.worktreeFingerprint ?? relevantWorkingTreeFingerprint(),
    started_at: startedAt.toISOString(),
    completed_at: null,
    verdict: "running",
    steps: [],
    reproducer: ["apps/sync/scripts/reliability-harness", options.profile],
  };
  writeManifest(runDirectory, manifest);
  return { manifest, runDirectory };
}

function runStep(candidate, options, runDirectory) {
  const stepStarted = process.hrtime.bigint();
  const spawn = options.spawn ?? spawnSync;
  const result = spawn(candidate.command[0], candidate.command.slice(1), {
    cwd: candidate.cwd,
    env: {
      ...process.env,
      CHALK_SYNC_RELIABILITY_PROFILE: options.profile,
      CHALK_SYNC_RELIABILITY_RUN_DIR: runDirectory,
      ...candidate.env,
    },
    stdio: "inherit",
  });

  return {
    passed: !result.error && result.status === 0,
    status: result.status ?? 1,
    evidence: {
      name: candidate.name,
      command: candidate.command,
      status: !result.error && result.status === 0 ? "passed" : "failed",
      exit_code: result.status,
      signal: result.signal,
      duration_ms: Math.round(Number(process.hrtime.bigint() - stepStarted) / 1_000_000),
    },
  };
}

function finishRun(options, runDirectory, manifest, verdict, status) {
  manifest.completed_at = (options.now?.() ?? new Date()).toISOString();
  manifest.verdict = verdict;
  writeManifest(runDirectory, manifest, true);
  return { manifest, runDirectory, status };
}

export function executeProfile(options) {
  const { manifest, runDirectory } = initializeRun(options);
  const plan = options.plan ?? createProfilePlan(options.profile, runDirectory);

  for (const candidate of plan) {
    const result = runStep(candidate, options, runDirectory);
    manifest.steps.push(result.evidence);

    if (!result.passed) return finishRun(options, runDirectory, manifest, "fail", result.status);
    writeManifest(runDirectory, manifest);
  }

  return finishRun(options, runDirectory, manifest, "pass", 0);
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const result = executeProfile(options);
    const label = result.manifest.verdict === "pass" ? "PASS" : "FAIL";
    console.log(`${label} profile=${options.profile} evidence=${result.runDirectory}`);
    process.exit(result.status);
  } catch (error) {
    console.error(`Reliability harness failed: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
