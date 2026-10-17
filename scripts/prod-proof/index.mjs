#!/usr/bin/env node
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { cleanupRun, createRun, loadConfig, save, check, publicFailure, recordResult } from "./runtime.mjs";
import { cleanupByRunId, runLabel, sweepStaleRuns } from "./cleanup.mjs";
import { prepareIntegration, recordProof, exportProof, transcriptProof, smokeProof } from "./proofs.mjs";

const plans = {
  all: {
    media: true,
    cameraShare: true,
    webhooks: true,
    proofs: ["camera-share", "export", "smoke", "transcript"],
  },
  smoke: {
    media: true,
    cameraShare: false,
    webhooks: true,
    proofs: ["export", "smoke"],
  },
  "camera-share": {
    media: true,
    cameraShare: true,
    webhooks: false,
    proofs: ["camera-share"],
  },
  export: {
    media: true,
    cameraShare: false,
    webhooks: false,
    proofs: ["export"],
  },
  transcript: {
    media: true,
    cameraShare: false,
    webhooks: false,
    proofs: ["transcript"],
  },
};
const usage = `Usage: pnpm prod:proof [all|smoke|camera-share|export|transcript] [--force-layer-switch|--no-layer-switch]
Cleanup: pnpm prod:proof cleanup <run-id>
Default: all, with forced layer switch. Each subcommand creates and cleans its own run.
Requirements: op (vault dev, local configuration only), ffmpeg, ffprobe, ImageMagick, Chromium,
             macOS say or Linux espeak; pnpm install and pnpm --filter @q9labsai/chalk-client exec playwright install chromium.
Private artifacts: .private/prod-proof/<run>/ (never commit). Configuration is loaded from 1Password or environment variables; API readiness checks capabilities.`;
const args = process.argv.slice(2);
const mode = args.find((argument) => !argument.startsWith("--")) ?? "all";
const known = new Set([...Object.keys(plans), "--force-layer-switch", "--no-layer-switch"]);
const invalid = [!plans[mode], args.some((arg) => !known.has(arg)), args.filter((arg) => Object.hasOwn(plans, arg)).length > 1, args.includes("--force-layer-switch") && args.includes("--no-layer-switch")].some(Boolean);
if (args.includes("--help")) console.log(usage);
else if (mode === "cleanup") {
  try {
    check(args.length === 2, "cleanup requires one run ID");
    runLabel(args[1]);
    await cleanupByRunId(await loadConfig({ readiness: false }), args[1]);
    console.log("PROOF cleanup: passed");
  } catch (error) {
    const directory = resolve(".private", "prod-proof", `cleanup-${randomUUID()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await save(`${directory}/error.json`, { error: error.stack, causes: error.errors?.map((entry) => entry.stack) });
    publicFailure("cleanup", error);
    process.exitCode = 1;
  }
} else if (invalid) {
  console.error(usage);
  process.exitCode = 1;
} else await main(mode, args.includes("--force-layer-switch") || (mode === "all" && !args.includes("--no-layer-switch")));

async function runProofs(run, plan, report, forceLayerSwitch) {
  let receiver;
  let captured;
  if (plan.media) {
    receiver = await prepareIntegration(run, plan.webhooks);
    captured = await recordProof(run, receiver, plan.cameraShare, forceLayerSwitch);
  }
  const actions = {
    "camera-share": async () => {
      check(!captured.camera.error, captured.camera.error);
      return captured.camera;
    },
    export: () => exportProof(run),
    smoke: () => {
      check(report.proofs.export.result === "passed", "MP4 Export/download did not pass");
      return smokeProof(run, receiver);
    },
    transcript: () => transcriptProof(run),
  };
  for (const name of plan.proofs) await recordResult(run, report, name, actions[name]);
}
async function clean(run, report) {
  if (!run) return;
  try {
    await cleanupRun(run);
    report.cleanup = "passed";
  } catch (error) {
    report.cleanup = "failed";
    report.cleanupError = error.stack ?? String(error);
    publicFailure("cleanup", error);
  }
}
async function finish(run, report, plan, directory) {
  await clean(run, report);
  report.completedAt = new Date().toISOString();
  report.wallSeconds = (performance.now() - report.startedMonotonic) / 1000;
  delete report.startedMonotonic;
  const complete = [!report.error, report.cleanup === "passed", ...plan.proofs.map((name) => report.proofs[name]?.result === "passed")].every(Boolean);
  report.result = complete ? "passed" : "failed";
  await save(`${directory}/report.json`, report);
  console.log(`Production proof ${report.result}; cleanup ${report.cleanup}`);
  if (!complete) process.exitCode = 1;
}
async function main(mode, forceLayerSwitch) {
  const runId = process.env.CHALK_PROOF_RUN_ID ?? `${Date.now()}-${randomUUID()}`;
  runLabel(runId);
  const directory = resolve(".private", "prod-proof", runId);
  const report = {
    mode,
    runId,
    startedMonotonic: performance.now(),
    startedAt: new Date().toISOString(),
    proofs: {},
    cleanup: "not-started",
    result: "failed",
  };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  console.log(`Private evidence: ${directory}`);
  let run;
  const interruption = new AbortController();
  const stop = () => interruption.abort(new Error("Production proof interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const config = await loadConfig();
    await sweepStaleRuns(config);
    run = await createRun(config, directory, interruption.signal, runId);
    await runProofs(run, plans[mode], report, forceLayerSwitch);
  } catch (error) {
    report.error = error.stack ?? String(error);
    publicFailure("setup-or-capture", error);
  } finally {
    await finish(run, report, plans[mode], directory);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
