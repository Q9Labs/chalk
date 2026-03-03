#!/usr/bin/env bun

import { dirname, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { buildMarkdown, buildSummary, printSummary } from "./lib/reporting.mjs";
import { requireAgentBrowser, runAttempt } from "./lib/runner.mjs";

const defaults = {
  baseUrl: "https://chalk.q9labs.ai",
  count: 100,
  concurrency: 10,
  joinTimeoutMs: 45000,
  pollIntervalMs: 1000,
  commandTimeoutMs: 60000,
  browserDefaultTimeoutMs: 25000,
  keepSessions: false,
  headed: false,
};

const options = parseArgs(process.argv.slice(2));
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runLabel = `${stamp}-n${options.count}-c${options.concurrency}`;
const outDir = resolve(options.outDir ?? `tests/results/agent-browser-join/${stamp}`);

await mkdir(outDir, { recursive: true });
await requireAgentBrowser();

const tasks = Array.from({ length: options.count }, (_, i) => i + 1);
const records = [];
let cursor = 0;

console.log(`[join-stress] start count=${options.count} concurrency=${options.concurrency} baseUrl=${options.baseUrl}`);
console.log(`[join-stress] outDir=${outDir}`);

const workers = Array.from({ length: options.concurrency }, (_, i) => i + 1).map((workerId) => runWorker(workerId));
await Promise.all(workers);

const summary = buildSummary(records, options, outDir, runLabel);
await writeFile(resolve(outDir, "results.ndjson"), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
await writeFile(resolve(outDir, "summary.json"), JSON.stringify(summary, null, 2) + "\n", "utf8");
await writeFile(resolve(outDir, "report.md"), buildMarkdown(summary, records), "utf8");
printSummary(summary);

async function runWorker(workerId) {
  while (cursor < tasks.length) {
    const index = tasks[cursor];
    cursor += 1;
    const record = await runAttempt({ attempt: index, workerId, options, outDir, runLabel });
    records.push(record);
    const label = record.status === "success" ? "ok" : "fail";
    const time = record.askToJoinToJoinedMs ?? "-";
    console.log(`[join-stress] ${label} attempt=${record.attempt} joinMs=${time} reason=${record.failureReason ?? "-"}`);
  }
}

function parseArgs(argv) {
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--count") out.count = Number(argv[++i]);
    else if (arg === "--concurrency") out.concurrency = Number(argv[++i]);
    else if (arg === "--base-url") out.baseUrl = String(argv[++i]);
    else if (arg === "--join-timeout-ms") out.joinTimeoutMs = Number(argv[++i]);
    else if (arg === "--poll-interval-ms") out.pollIntervalMs = Number(argv[++i]);
    else if (arg === "--command-timeout-ms") out.commandTimeoutMs = Number(argv[++i]);
    else if (arg === "--browser-timeout-ms") out.browserDefaultTimeoutMs = Number(argv[++i]);
    else if (arg === "--out-dir") out.outDir = String(argv[++i]);
    else if (arg === "--keep-sessions") out.keepSessions = true;
    else if (arg === "--headed") out.headed = true;
    else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown arg: ${arg}`);
    }
  }
  if (!Number.isFinite(out.count) || out.count < 1) throw new Error("--count must be >= 1");
  if (!Number.isFinite(out.concurrency) || out.concurrency < 1) throw new Error("--concurrency must be >= 1");
  out.concurrency = Math.min(out.concurrency, out.count);
  return out;
}

function printHelp() {
  const name = process.argv[1] ? dirname(process.argv[1]) : "join-rooms.mjs";
  console.log(`Usage:
  bun ${name}/join-rooms.mjs [options]

Options:
  --count <n>              Number of rooms to join (default: 100)
  --concurrency <n>        Parallel browser sessions (default: 10)
  --base-url <url>         Site URL (default: https://chalk.q9labs.ai)
  --join-timeout-ms <n>    Max wait for join completion (default: 45000)
  --poll-interval-ms <n>   Poll interval for joined state (default: 1000)
  --command-timeout-ms <n> Per agent-browser command timeout (default: 60000)
  --browser-timeout-ms <n> AGENT_BROWSER_DEFAULT_TIMEOUT (default: 25000)
  --out-dir <path>         Output directory
  --keep-sessions          Keep sessions open after each attempt
  --headed                 Run headed browser
  --help                   Show help
`);
}
