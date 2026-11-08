#!/usr/bin/env node
// The parent owns the shared lease; the child measures and retries under that lease.
import { execFileSync, spawn } from "node:child_process";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { contention, signal } from "./contention.mjs";
import { readLogs } from "./staging-logs.mjs";
import { parseScorecard, SCORECARD_SCHEMA } from "./schema.mjs";

const evidence = resolve(".private/latency-scorecard");
const leaseFile = resolve(".private/staging-lease.json");
const output = resolve(evidence, "scorecard-chalk_sfu.json");
const prefix = process.env.RUN_PREFIX;
if (!/^[A-Za-z0-9_-]+$/.test(prefix ?? "")) throw new Error("RUN_PREFIX must be a plain run label");

async function json(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function emptyCard() {
  return {
    schema: SCORECARD_SCHEMA,
    run: { id: `${prefix}-latency`, commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), tier: "nightly", environment: "staging", startedAt: new Date().toISOString(), client: { kind: "browser", browser: "unknown", region: "github-hosted", size: "ubuntu-24-04" } },
    mediaPlane: "chalk_sfu",
    metrics: [],
    dropped: [],
  };
}

async function save(card) {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await writeFile(output, `${JSON.stringify(parseScorecard(card), null, 2)}\n`, { mode: 0o600 });
}

async function logs(start, end) {
  try {
    return await readLogs(new Date(start).toISOString(), new Date(end).toISOString());
  } catch {
    // Error bodies may contain private query results. The public signal records the gap.
    console.error("Staging API-log readout unavailable.");
    return undefined;
  }
}

// Allow 30 seconds for log ingestion; a quiet API window is observable, not proof of node idleness.
async function quietWindow() {
  const end = Date.now() - 30_000;
  return logs(end - 30_000, end);
}

function workload(program, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(program, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => accept(code ?? 1));
  });
}

async function measure() {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let before = await quietWindow();
    if (attempt === 2) {
      console.log("Contended attempt; waiting up to 10 minutes for a quiet staging API-log window before one retry.");
      const deadline = Date.now() + 600_000;
      while ((!before || before.length > 0) && Date.now() < deadline) {
        await delay(Math.min(15_000, deadline - Date.now()));
        before = await quietWindow();
      }
    }
    const start = Date.now();
    const runId = `${prefix}-latency-${attempt}`;
    const directory = resolve(".private/prod-proof", runId);
    let status = 1;
    // Do not add load to an already busy or unobservable node.
    if (before && before.length === 0) {
      await appendFile(".private/proof-run-ids", `${runId}\n`);
      // Keep timeout and the kit in the lease's process group so lease loss stops both.
      status = await workload("timeout", ["--foreground", "--signal=TERM", "--kill-after=10s", "20m", "pnpm", "prod:latency", "--planes", "chalk_sfu", "--environment", "staging", "--tier", "nightly", "--region", "github-hosted", "--size", "ubuntu-24-04"], {
        env: { ...process.env, CHALK_PROOF_RUN_ID: runId },
      });
    }
    const end = Date.now();
    await delay(30_000);
    const window = await logs(start, end);
    const after = await logs(end, Date.now());
    const card = await json(resolve(directory, "scorecard-chalk_sfu.json"), await emptyCard());
    let ownEpisodes = [];
    try {
      ownEpisodes = (await readFile(resolve(directory, "episodes.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    card.contention = contention({ lease: await json(leaseFile), before, after, window, ownEpisodes });
    // A skipped attempt or missing boundary readout cannot be accepted as an isolated run.
    if (!before || before.length > 0 || !after || card.metrics.length === 0) card.contention.contended = true;
    await save(card);
    await writeFile(resolve(evidence, `attempt-${attempt}.json`), JSON.stringify(card));
    if (!card.contention.contended) return status;
  }
  return 1;
}

async function main() {
  if (process.argv.includes("--leased")) return measure();
  let status;
  for (let attempt = 1; attempt <= 2; attempt++) {
    status = await workload("scripts/staging-sfu/staging-lock", ["--holder", "nightly-latency", "--purpose", "action-latency", "--run-id", process.env.GITHUB_RUN_ID ?? prefix, "--evidence", leaseFile, "--wait", attempt === 1 ? "0" : "600", "--", process.execPath, import.meta.filename, "--leased"]);
    if ((await json(leaseFile))?.acquired) break;
    if (attempt === 1) console.log("Staging SFU lease busy; retrying once with a bounded 10-minute wait.");
  }
  const lease = await json(leaseFile);
  const card = await json(output, { ...(await emptyCard()), contention: contention({ lease }) });
  if (!lease?.acquired || lease.lost) {
    card.contention.contended = true;
    card.contention.lease_acquired = signal(!!lease?.acquired, "github_lease");
    card.contention.lease_lost = signal(!!lease?.lost, "github_lease");
  }
  await save(card);
  return card.contention.contended ? 1 : status;
}

try {
  process.exitCode = await main();
} catch {
  console.error("Staging latency measurement failed; retaining an inconclusive card.");
  await save({ ...(await emptyCard()), contention: contention({ lease: await json(leaseFile) }) });
  process.exitCode = 1;
}
