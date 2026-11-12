#!/usr/bin/env node
import { recordingRejoinProof } from "./recording-rejoin.mjs";
import { callArtifactsProof, captureCall } from "./call-artifacts.mjs";
import { leaveProof } from "./leave.mjs";
import { leaveOwnSfuProof } from "./leave-own-sfu.mjs";
import { ensureOwnSfuSpaces } from "./own-sfu-spaces.mjs";
import { offReasonProof } from "./off-reason.mjs";
import { chatUploadProof } from "./chat-upload.mjs";
import { longCallPlan, longCallProof } from "./long-call.mjs";
import { toggleOffersPlan, toggleOffersProof } from "./toggle-offers.mjs";
import { resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createRun, loadConfig, save, check, publicFailure, recordResult, errorEvidence } from "./runtime.mjs";
import { cleanupRun, cleanupByRunId, runLabel, sweepStaleRuns } from "./cleanup.mjs";
import { createProofKey, prepareIntegration, recordProof, exportProof, transcriptProof, smokeProof } from "./proofs.mjs";

const plans = {
  leave: { media: false, webhooks: false, proofs: ["leave"] },
  // The current client's Leave on the own SFU (CHALK_PROOF_MEDIA_PLANE=chalk_sfu): acknowledgement, released capture, removed participant and media.
  "leave-own-sfu": { media: false, webhooks: false, proofs: ["leave-own-sfu"] },
  // Finds or creates Promote's two own-SFU proof Spaces by slug and moves them to chalk_sfu. Run it before the release that adds the per-Space setting deploys.
  "own-sfu-spaces": { media: false, ensureSpaces: true, webhooks: false, proofs: ["own-sfu-spaces"] },
  offreason: { media: false, webhooks: false, proofs: ["offreason"] },
  // A real chat attachment upload from an origin on no list: preflight, PUT, finalize and download against the storage bucket. No browser or media.
  "chat-upload": { media: false, webhooks: false, proofs: ["chat-upload"] },
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
  "recording-rejoin": {
    media: true,
    rejoin: true,
    cameraShare: false,
    webhooks: false,
    proofs: ["export", "recording-rejoin"],
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
    webhooks: true,
    proofs: ["transcript"],
  },
  // Three guests with automatic Recording and Transcript, on the media plane CHALK_PROOF_MEDIA_PLANE selects.
  "call-artifacts": {
    media: false,
    callArtifacts: true,
    webhooks: false,
    proofs: ["export", "call-artifacts"],
  },
  // Three guests held across media-access refreshes for at least ten minutes, with mic and camera toggles on a schedule. Opt-in: nightly only.
  "long-call": {
    media: false,
    longCall: true,
    webhooks: false,
    proofs: ["long-call"],
  },
  // Three guests toggle the microphone and camera 50 times and the offers they send must not grow; the deafness probe runs in the same calls. Opt-in, own SFU.
  "toggle-offers": {
    media: false,
    longCall: true,
    webhooks: false,
    proofs: ["toggle-offers"],
  },
};
const dryRuns = { "long-call": longCallPlan, "toggle-offers": toggleOffersPlan };
const usage = `Usage: pnpm prod:proof [all|smoke|camera-share|recording-rejoin|export|transcript|call-artifacts|long-call|toggle-offers|leave|leave-own-sfu|own-sfu-spaces|offreason|chat-upload] [--force-layer-switch|--no-layer-switch] [long-call|toggle-offers --dry-run]
Cleanup: pnpm prod:proof cleanup <run-id>
Default: all, with forced layer switch. Each subcommand creates and cleans its own run.
Requirements: op (vault dev, local configuration only), ffmpeg, ffprobe, ImageMagick, Chromium,
             macOS say or Linux espeak; pnpm install and pnpm --filter @q9labsai/chalk-client exec playwright install chromium.
offreason and chat-upload need no browser. CHALK_PROOF_CANDIDATE_SDK_ENTRY (optional) is the path to a built SDK entry to prove instead of the checkout, such as an installed package's dist/index.js.
Private artifacts: .private/prod-proof/<run>/ (never commit). Configuration is loaded from 1Password or environment variables; API readiness checks capabilities.`;
const args = process.argv.slice(2);
const mode = args.find((argument) => !argument.startsWith("--")) ?? "all";
const known = new Set([...Object.keys(plans), "--force-layer-switch", "--no-layer-switch", "--dry-run"]);
const invalid = [!plans[mode], args.some((arg) => !known.has(arg)), args.filter((arg) => Object.hasOwn(plans, arg)).length > 1, args.includes("--force-layer-switch") && args.includes("--no-layer-switch"), args.includes("--dry-run") && !dryRuns[mode]].some(Boolean);
if (args.includes("--help")) console.log(usage);
else if (!invalid && args.includes("--dry-run")) console.log(dryRuns[mode]());
else if (mode === "cleanup") {
  try {
    check(args.length === 2, "cleanup requires one run ID");
    runLabel(args[1]);
    await cleanupByRunId(await loadConfig({ readiness: false }), args[1]);
    console.log("PROOF cleanup: passed");
  } catch (error) {
    const directory = resolve(".private", "prod-proof", `cleanup-${randomUUID()}`);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await save(`${directory}/error.json`, errorEvidence(error));
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
    captured = await recordProof(run, receiver, plan.cameraShare, forceLayerSwitch, plan.rejoin);
  }
  let call;
  if (plan.callArtifacts) {
    receiver = await prepareIntegration(run, plan.webhooks);
    call = await captureCall(run, receiver);
  }
  if (plan.longCall) receiver = await prepareIntegration(run, false);
  if (plan.ensureSpaces) await createProofKey(run);
  const actions = {
    "long-call": () => longCallProof(run, receiver),
    "toggle-offers": () => toggleOffersProof(run, receiver),
    leave: () => leaveProof(run),
    "leave-own-sfu": () => leaveOwnSfuProof(run),
    "own-sfu-spaces": () => ensureOwnSfuSpaces(run),
    offreason: () => offReasonProof(run),
    "chat-upload": () => chatUploadProof(run),
    "camera-share": async () => {
      check(!captured.camera.error, captured.camera.error);
      return captured.camera;
    },
    export: () => exportProof(run),
    "recording-rejoin": () => {
      check(report.proofs.export.result === "passed", "MP4 Export/download did not pass");
      return recordingRejoinProof(run, report.proofs.export.evidence);
    },
    smoke: () => {
      check(report.proofs.export.result === "passed", "MP4 Export/download did not pass");
      return smokeProof(run, receiver);
    },
    transcript: () => transcriptProof(run, receiver),
    "call-artifacts": () => {
      check(report.proofs.export.result === "passed", "MP4 Export/download did not pass");
      return callArtifactsProof(run, call);
    },
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
    report.cleanupError = errorEvidence(error);
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
    report.error = errorEvidence(error);
    publicFailure("setup-or-capture", error);
  } finally {
    await finish(run, report, plans[mode], directory);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
