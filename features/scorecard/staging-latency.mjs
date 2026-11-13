#!/usr/bin/env node
// The parent owns the shared lease; the child measures and retries under that lease.
import { execFileSync, spawn } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { contention, signal } from "./contention.mjs";
import { readLogs } from "./staging-logs.mjs";
import { readNodeMetrics } from "./staging-metrics.mjs";
import { diagnosticsFileName } from "./diagnostics.mjs";
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

// The latency run writes its diagnostics sidecar beside its card. Carry it to the evidence directory next to the saved card,
// and drop an earlier attempt's copy so the pair always comes from one attempt. Only the run summary reads it.
async function carrySidecar(directory) {
  const name = diagnosticsFileName("chalk_sfu");
  await rm(resolve(evidence, name), { force: true });
  try {
    await copyFile(resolve(directory, name), resolve(evidence, name));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
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

async function nodeMetrics(start, end, options) {
  try {
    return await readNodeMetrics(new Date(start).toISOString(), new Date(end).toISOString(), options);
  } catch (error) {
    const reason = /^staging_metrics_(configuration_missing|endpoint_invalid|query_(empty|failed|incomplete|malformed))$/.test(error?.message) ? error.message : "staging_metrics_query_unavailable";
    console.error(`Staging node metrics unavailable: ${reason}.`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `Staging node metrics unavailable: \`${reason}\`.\n`);
    return [];
  }
}

// Allow 30 seconds for log ingestion; a quiet API window is observable, not proof of node idleness.
async function quietWindow() {
  const end = Date.now() - 30_000;
  return { events: await logs(end - 30_000, end), end };
}

function workload(program, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(program, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => accept(code ?? 1));
  });
}

async function measure() {
  let retryPreflight = false;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let before = await quietWindow();
    if (attempt === 2) {
      if (retryPreflight) {
        console.log("Node metrics unavailable before load; retrying the preflight once without starting another workload.");
        await delay(2_000);
        before = await quietWindow();
      } else {
        console.log("Contended attempt; waiting up to 10 minutes for a quiet staging API-log window before one retry.");
        const deadline = Date.now() + 600_000;
        while ((!before.events || before.events.length > 0) && Date.now() < deadline) {
          await delay(Math.min(15_000, deadline - Date.now()));
          before = await quietWindow();
        }
      }
    }
    const boundary = before.end;
    const nodeBeforeResult = await nodeMetrics(boundary - 30_000, boundary, { refreshSessions: true });
    const nodeBefore = nodeBeforeResult ?? [];
    const preflightMetricsUnavailable = nodeBeforeResult === null || nodeBefore.length === 0;
    const start = Date.now();
    const runId = `${prefix}-latency-${attempt}`;
    const directory = resolve(".private/prod-proof", runId);
    let status = 1;
    // Do not add load to an already busy or unobservable node.
    // Staging runs a primary and a standby, so every reporting node must be idle, not one node alone.
    const nodeIdle = nodeBefore.length > 0 && nodeBefore.every((row) => Number.isFinite(row.host?.stealPercent) && row.sessions === 0 && row.draining === false);
    const workloadRuns = before.events && before.events.length === 0 && nodeIdle;
    if (!workloadRuns) console.log("No workload started: the API log or a staging node was not idle before load.");
    if (workloadRuns) {
      await appendFile(".private/proof-run-ids", `${runId}\n`);
      // Keep timeout and the kit in the lease's process group so lease loss stops both.
      const measurementEnv = { ...process.env, CHALK_PROOF_RUN_ID: runId };
      delete measurementEnv.CHALK_AXIOM_METRICS_QUERY_TOKEN;
      status = await workload(
        "timeout",
        ["--foreground", "--signal=TERM", "--kill-after=10s", "40m", "pnpm", "prod:latency", "--samples", process.env.CHALK_LATENCY_SAMPLES || "60", "--planes", "chalk_sfu", "--environment", "staging", "--tier", "nightly", "--region", "github-hosted", "--size", "ubuntu-24-04"],
        {
          env: measurementEnv,
        },
      );
    }
    const end = Date.now();
    await delay(30_000);
    // Include joins while the preflight queries ran, not just events after the kit began.
    const window = await logs(before.end, end);
    const after = await logs(end, Date.now());
    // A skipped workload leaves a zero-width window, which Axiom rejects with HTTP 400.
    const [nodeWindowResult, nodeAfterResult] = await Promise.all([workloadRuns ? nodeMetrics(start, end) : [], nodeMetrics(end, Date.now())]);
    const nodeWindow = nodeWindowResult ?? [];
    const nodeAfter = nodeAfterResult ?? [];
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
    const metricsUnavailable = nodeBeforeResult === null || nodeWindowResult === null || nodeAfterResult === null || nodeBefore.length === 0 || nodeWindow.length === 0 || nodeAfter.length === 0;
    card.contention = contention({ lease: await json(leaseFile), before: before.events, after, window, ownEpisodes, nodeBefore, nodeWindow, nodeAfter, unobservable: metricsUnavailable });
    // A skipped attempt or missing boundary readout cannot be accepted as an isolated run.
    if (!before.events || before.events.length > 0 || !after || (card.metrics.length === 0 && !card.contention.unobservable)) card.contention.contended = true;
    await save(card);
    await carrySidecar(directory);
    await writeFile(resolve(evidence, `attempt-${attempt}.json`), JSON.stringify(card));
    if (card.contention.contended) continue;
    if (card.contention.unobservable) {
      if (attempt === 1 && preflightMetricsUnavailable) {
        retryPreflight = true;
        continue;
      }
      return 1;
    }
    return status;
  }
  return 1;
}

async function main() {
  if (process.argv.includes("--leased")) return measure();
  let status;
  for (let attempt = 1; attempt <= 2; attempt++) {
    status = await workload("scripts/staging-sfu/staging-lock", ["--holder", "nightly-latency", "--purpose", "action-latency", "--run-id", process.env.GITHUB_RUN_ID ?? prefix, "--evidence", leaseFile, "--wait", attempt === 1 ? "0" : "1800", "--", process.execPath, import.meta.filename, "--leased"]);
    if ((await json(leaseFile))?.acquired) break;
    if (attempt === 1) console.log("Staging SFU lease busy; retrying once with a bounded 30-minute wait.");
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
