#!/usr/bin/env node
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { cleanupRun, createRun, loadConfig, save, check } from "./runtime.mjs";
import { prepareIntegration, recordProof, exportProof, transcriptProof, resetProof, smokeProof } from "./proofs.mjs";

const plans = {
  all: { media: true, cameraShare: true, webhooks: true, proofs: ["camera-share", "export", "smoke", "transcript", "reset"] },
  smoke: { media: true, cameraShare: false, webhooks: true, proofs: ["export", "smoke"] },
  "camera-share": { media: true, cameraShare: true, webhooks: false, proofs: ["camera-share"] },
  export: { media: true, cameraShare: false, webhooks: false, proofs: ["export"] },
  transcript: { media: true, cameraShare: false, webhooks: false, proofs: ["transcript"] },
  reset: { media: false, proofs: ["reset"] },
};
const usage = `Usage: pnpm prod:proof [all|smoke|camera-share|export|transcript|reset] [--force-layer-switch|--no-layer-switch]
Default: all, with forced layer switch. Each subcommand creates and cleans its own run.
Requirements: op (vault dev), aws, ffmpeg, ffprobe, ImageMagick, Chromium,
             macOS say or Linux espeak; pnpm install and pnpm --filter @q9labsai/chalk-client exec playwright install chromium.
Private artifacts: .private/prod-proof/<run>/ (never commit). Configuration is loaded from 1Password and SSM.`;
const args = process.argv.slice(2);
const mode = args.find((argument) => !argument.startsWith("--")) ?? "all";
const known = new Set([...Object.keys(plans), "--force-layer-switch", "--no-layer-switch"]);
const invalid = [!plans[mode], args.some((arg) => !known.has(arg)), args.filter((arg) => Object.hasOwn(plans, arg)).length > 1, args.includes("--force-layer-switch") && args.includes("--no-layer-switch")].some(Boolean);
if (args.includes("--help")) console.log(usage);
else if (invalid) {
  console.error(usage);
  process.exitCode = 1;
} else await main(mode, args.includes("--force-layer-switch") || (mode === "all" && !args.includes("--no-layer-switch")));

async function recordResult(run, report, name, execute) {
  console.log(`PROOF ${name}: started`);
  try {
    report.proofs[name] = { result: "passed", evidence: await execute() };
    console.log(`PROOF ${name}: passed`);
  } catch (error) {
    report.proofs[name] = { result: "failed", error: error.message };
    console.log(`PROOF ${name}: failed (${error.message})`);
  }
  await save(`${run.directory}/report.json`, report);
}
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
    reset: () => resetProof(run),
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
    report.cleanupError = error.message;
  }
}
async function finish(run, report, plan) {
  await clean(run, report);
  report.completedAt = new Date().toISOString();
  const complete = [!report.error, report.cleanup === "passed", ...plan.proofs.map((name) => report.proofs[name]?.result === "passed")].every(Boolean);
  report.result = complete ? "passed" : "failed";
  if (run) await save(`${run.directory}/report.json`, report);
  console.log(`Production proof ${report.result}; cleanup ${report.cleanup}`);
  if (!complete) process.exitCode = 1;
}
async function main(mode, forceLayerSwitch) {
  const directory = resolve(".private", "prod-proof", `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`);
  const report = { mode, startedAt: new Date().toISOString(), proofs: {}, cleanup: "not-started", result: "failed" };
  let run;
  const interruption = new AbortController();
  const stop = () => interruption.abort(new Error("Production proof interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    run = await createRun(await loadConfig(), directory, interruption.signal);
    console.log(`Private evidence: ${directory}`);
    await runProofs(run, plans[mode], report, forceLayerSwitch);
  } catch (error) {
    report.error = error.message;
    console.error(`Production proof failed: ${error.message}`);
  } finally {
    await finish(run, report, plans[mode]);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
