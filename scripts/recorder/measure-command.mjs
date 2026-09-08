#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LABELS = new Set(["deterministic-local", "live-nonproduction-provider", "production-runtime-qualified"]);

function parseArguments(argv) {
  const separator = argv.indexOf("--");
  if (separator === -1 || separator === argv.length - 1) {
    throw new Error("usage: measure-command.mjs --evidence <path> --label <label> -- <command> [arguments]");
  }
  let evidence = "";
  let label = "";
  let stderr = "";
  let stdout = "";
  for (let index = 0; index < separator; index += 1) {
    const name = argv[index];
    if (name !== "--evidence" && name !== "--label" && name !== "--stderr" && name !== "--stdout") {
      throw new Error(`unknown option: ${name}`);
    }
    const value = argv[index + 1];
    if (!value || value === "--") throw new Error(`${name} requires a value`);
    index += 1;
    if (name === "--evidence") evidence = value;
    else if (name === "--label") label = value;
    else if (name === "--stderr") stderr = path.resolve(value);
    else stdout = path.resolve(value);
  }
  if (evidence === "") throw new Error("--evidence is required");
  if (!LABELS.has(label)) throw new Error(`--label must be one of ${[...LABELS].join(", ")}`);
  return { command: argv.slice(separator + 1), evidence: path.resolve(evidence), label, stderr, stdout };
}

function numberMatch(text, expression) {
  const match = text.match(expression);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseDarwinTime(text) {
  return {
    involuntary_context_switches: numberMatch(text, /^\s*(\d+)\s+involuntary context switches$/m),
    peak_rss_bytes: numberMatch(text, /^\s*(\d+)\s+maximum resident set size$/m),
    system_seconds: numberMatch(text, /^sys\s+([\d.]+)$/m),
    user_seconds: numberMatch(text, /^user\s+([\d.]+)$/m),
    voluntary_context_switches: numberMatch(text, /^\s*(\d+)\s+voluntary context switches$/m),
  };
}

function parseElapsed(value) {
  if (!value) return null;
  const parts = value.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3_600 + parts[1] * 60 + parts[2];
  return parts[0];
}

function parseLinuxTime(text) {
  const elapsed = text.match(/^\s*Elapsed \(wall clock\) time.*:\s*(\S+)$/m)?.[1];
  const peakRSSKilobytes = numberMatch(text, /^\s*Maximum resident set size \(kbytes\):\s*(\d+)$/m);
  return {
    elapsed_seconds: parseElapsed(elapsed),
    involuntary_context_switches: numberMatch(text, /^\s*Involuntary context switches:\s*(\d+)$/m),
    peak_rss_bytes: peakRSSKilobytes === null ? null : peakRSSKilobytes * 1_024,
    system_seconds: numberMatch(text, /^\s*System time \(seconds\):\s*([\d.]+)$/m),
    user_seconds: numberMatch(text, /^\s*User time \(seconds\):\s*([\d.]+)$/m),
    voluntary_context_switches: numberMatch(text, /^\s*Voluntary context switches:\s*(\d+)$/m),
  };
}

function execute(command, arguments_, metricsFile, stdout, stderr) {
  const timeArguments = process.platform === "darwin" ? ["-lp", "-o", metricsFile] : ["-v", "-o", metricsFile];
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/time", [...timeArguments, command, ...arguments_], {
      env: process.env,
      stdio: ["ignore", stdout, stderr],
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  process.umask(0o077);
  const options = parseArguments(process.argv.slice(2));
  const temporary = await mkdtemp(path.join(os.tmpdir(), "chalk-recording-measure-"));
  const metricsFile = path.join(temporary, "time.txt");
  const startedAt = new Date();
  const started = process.hrtime.bigint();
  const stdout = options.stdout === "" ? null : await open(options.stdout, "w", 0o600);
  const stderr = options.stderr === "" ? null : await open(options.stderr, "w", 0o600);
  try {
    const result = await execute(options.command[0], options.command.slice(1), metricsFile, stdout?.fd ?? "inherit", stderr?.fd ?? "inherit");
    const wallNanoseconds = process.hrtime.bigint() - started;
    const endedAt = new Date();
    const raw = await readFile(metricsFile, "utf8");
    const resource = process.platform === "darwin" ? parseDarwinTime(raw) : parseLinuxTime(raw);
    const wallSeconds = Number(wallNanoseconds) / 1_000_000_000;
    const cpuSeconds = (resource.user_seconds ?? 0) + (resource.system_seconds ?? 0);
    const evidence = {
      evidence_version: "recording-command-evidence.v1",
      qualification_label: options.label,
      command: options.command,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      exit: { code: result.code, signal: result.signal },
      runtime: {
        arch: process.arch,
        cpu_count: os.cpus().length,
        platform: process.platform,
      },
      resources: {
        ...resource,
        average_cpu_percent: wallSeconds === 0 ? null : Math.round((cpuSeconds / wallSeconds) * 10_000) / 100,
        wall_seconds: Math.round(wallSeconds * 1_000) / 1_000,
      },
    };
    await writeFile(options.evidence, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    await chmod(options.evidence, 0o600);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    if (result.code !== 0 || result.signal !== null) process.exitCode = result.code ?? 1;
  } finally {
    await Promise.all([stdout?.close(), stderr?.close()]);
    await rm(temporary, { force: true, recursive: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
