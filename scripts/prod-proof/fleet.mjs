#!/usr/bin/env node
// Canary fleet: many concurrent scripted calls on one provider, counted in calls and call-hours.
//
//   CHALK_PROOF_CONFIG_SOURCE=env CHALK_PROOF_MEDIA_PLANE=chalk_sfu \
//   CHALK_CANARY_FAULT_DOWN='iptables -I OUTPUT -p udp ! --dport 53 -j DROP' \
//   CHALK_CANARY_FAULT_UP='iptables -D OUTPUT -p udp ! --dport 53 -j DROP' \
//   node scripts/prod-proof/fleet.mjs --allow-host <api host> [--concurrency 6] [--calls 200] [--call-hours 50]
//   node scripts/prod-proof/fleet.mjs --dry-run ...        # no API, no browsers: the scheduler and the summary only
//   node scripts/prod-proof/fleet.mjs --merge a/fleet-calls.json b/fleet-calls.json   # one summary for several machines
//
// The canary exit by volume: scripted joins and fault trials pass, plus at least 200 calls
// and 50 call-hours with no P1. See scripts/prod-proof/README.md, "Canary fleet", for what a call does and what a P1 is.
import { mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { cpus, loadavg } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { check, checkCapabilities, command, createRun, errorEvidence, loadConfig, mediaPlane, publicFailure, request, save, waitFor } from "./runtime.mjs";
import { cleanupRun, runLabel, sweepStaleRuns } from "./cleanup.mjs";
import { FaultPulse } from "./fleet-fault.mjs";
import { finding, summarizeFleet, volumeExit, wantsMoreCalls } from "./fleet-criteria.mjs";
import { generator, planCall } from "./fleet-plan.mjs";

const keyRotationMs = 30 * 60 * 1000;

function range(value, label, minimum) {
  const [low, high = low] = value.split(":").map(Number);
  check(Number.isInteger(low) && Number.isInteger(high) && low >= minimum && high >= low, `--${label} must be N or LOW:HIGH, whole numbers from ${minimum}`, "configuration");
  return [low, high];
}

export function parseOptions(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      "allow-host": { type: "string", multiple: true, default: [] },
      calls: { type: "string", default: String(volumeExit.calls) },
      "call-hours": { type: "string", default: String(volumeExit.callHours) },
      concurrency: { type: "string", default: "6" },
      guests: { type: "string", default: "2:6" },
      "call-seconds": { type: "string", default: "300:1500" },
      "screen-fraction": { type: "string", default: "0.3" },
      "rejoin-fraction": { type: "string", default: "0.3" },
      "recording-fraction": { type: "string", default: "0" },
      "fault-interval-seconds": { type: "string", default: "600" },
      "fault-seconds": { type: "string", default: "6" },
      camera: { type: "string", default: "640x360" },
      "max-load": { type: "string", default: "0.85" },
      spaces: { type: "string", default: "" },
      seed: { type: "string", default: String(Date.now()) },
      "no-stop-on-p1": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "env-file": { type: "string" },
      merge: { type: "boolean", default: false },
      "heartbeat-seconds": { type: "string", default: "60" },
    },
    allowPositionals: true,
  });
  const camera = values.camera.match(/^(\d+)x(\d+)$/);
  const fractions = ["screen-fraction", "rejoin-fraction", "recording-fraction"].map((name) => [name, Number(values[name])]);
  for (const [name, fraction] of fractions) check(fraction >= 0 && fraction <= 1, `--${name} must be from 0 to 1`, "configuration");
  check(camera, "--camera must be WIDTHxHEIGHT", "configuration");
  const options = {
    allowHosts: values["allow-host"],
    targets: { calls: Number(values.calls), callHours: Number(values["call-hours"]) },
    concurrency: Number(values.concurrency),
    guests: range(values.guests, "guests", 2),
    callSeconds: range(values["call-seconds"], "call-seconds", 60),
    screenFraction: Number(values["screen-fraction"]),
    rejoinFraction: Number(values["rejoin-fraction"]),
    recordingFraction: Number(values["recording-fraction"]),
    faultIntervalMs: Number(values["fault-interval-seconds"]) * 1000,
    faultMs: Number(values["fault-seconds"]) * 1000,
    camera: { width: Number(camera[1]), height: Number(camera[2]) },
    maxLoad: Number(values["max-load"]),
    spaceIds: values.spaces ? values.spaces.split(",") : [],
    seed: Number(values.seed),
    stopOnP1: !values["no-stop-on-p1"],
    dryRun: values["dry-run"],
    envFile: values["env-file"],
    merge: values.merge,
    heartbeatMs: Number(values["heartbeat-seconds"]) * 1000,
    files: positionals,
  };
  check(Number.isInteger(options.concurrency) && options.concurrency >= 1 && options.concurrency <= 64, "--concurrency must be a whole number from 1 to 64", "configuration");
  check(options.guests[1] <= 6, "--guests: a canary call has at most 6 guests", "configuration");
  check(options.faultMs >= 4000, "--fault-seconds must be at least 4, so the stall can be proved", "configuration");
  check(options.recordingFraction === 0 || options.spaceIds.length === 0, "--recording-fraction needs fresh Spaces with an automatic Recording policy, so it cannot combine with --spaces", "configuration");
  check(options.spaceIds.length === 0 || options.spaceIds.length >= options.concurrency, "--spaces needs at least as many Spaces as --concurrency, because a Space holds one live Episode", "configuration");
  return options;
}

/**
 * Runs calls until the volume targets are covered, filling `calls` with every call record. `startCall` runs one call;
 * `signal` stops new calls. Fault pulses run on their own timer while calls are running.
 */
export async function runScheduler({ options, calls, startCall, pulse, signal, onFinished }) {
  const random = generator(options.seed);
  const running = new Map();
  const over = new AbortController();
  let started = 0;
  const sums = () => ({
    started,
    doneHours: summarizeFleet(calls).callHours,
    runningHours: [...running.values()].reduce((total, entry) => total + entry.spec.holdSeconds / 3600, 0),
    p1: calls.filter((call) => call.findings.some((entry) => entry.p1)).length,
  });
  const wanted = () => !signal.aborted && wantsMoreCalls(sums(), options.targets, options.stopOnP1);
  const overloaded = () => !options.dryRun && loadavg()[0] / cpus().length > options.maxLoad;
  const pulses = pulse.configured ? pulseLoop(pulse, options, running, over.signal) : Promise.resolve();
  while (wanted() || running.size > 0) {
    while (running.size < options.concurrency && !pulse.pending && !overloaded() && wanted()) {
      const recording = random() < options.recordingFraction && ![...running.values()].some((entry) => entry.spec.recording);
      const spec = planCall(random, options, `call-${String(++started).padStart(4, "0")}`, recording);
      const entry = { spec, done: undefined };
      entry.done = startCall(spec).then((record) => {
        calls.push(record);
        running.delete(spec.id);
        onFinished(record);
      });
      running.set(spec.id, entry);
    }
    await Promise.race([...[...running.values()].map((entry) => entry.done), sleep(1000)]);
  }
  over.abort();
  await pulses;
  return calls;
}

async function pulseLoop(pulse, options, running, signal) {
  for (;;) {
    try {
      await sleep(options.faultIntervalMs, undefined, { signal });
    } catch {
      return;
    }
    if (running.size > 0) await pulse.run();
  }
}

function fleetSummary(options, calls, startedAt) {
  return { plane: mediaPlane, startedAt, endedAt: new Date().toISOString(), dryRun: options.dryRun, targets: options.targets, concurrency: options.concurrency, seed: options.seed, ...summarizeFleet(calls) };
}

function dryRunCall(spec) {
  const renderedAt = Date.now();
  const hold = spec.holdSeconds * 1000;
  return sleep(5 + (spec.holdSeconds % 7)).then(() => ({
    id: spec.id,
    guests: spec.guests,
    plane: mediaPlane,
    recording: spec.recording,
    startedAt: renderedAt,
    renderedAt,
    endedAt: renderedAt + hold,
    joinMs: 1500 + (spec.holdSeconds % 2000),
    faults: [],
    findings: [],
    actions: spec.actions.map((action) => ({ kind: action.kind, ms: 800 })),
  }));
}

// Space ids come from an allowlist or each call creates its own Space, which cleanup archives at the end.
function spacePool(run, ids, createSpace) {
  const free = [...ids];
  const spaces = new Map();
  return {
    async acquire(policy) {
      if (ids.length === 0) return { space: await createSpace(run, mediaPlane, policy), release: async () => {} };
      await waitFor("a free allowlisted Space", async () => free.length > 0, 300_000, 500);
      const id = free.shift();
      if (!spaces.has(id)) spaces.set(id, run.apiRequest("GET", `${run.tenantPath}/spaces/${id}`));
      const space = await spaces.get(id);
      check((space.effective_media_plane ?? space.media_plane) === mediaPlane, `Space uses ${space.effective_media_plane ?? space.media_plane}, not ${mediaPlane}`);
      return { space, release: async () => void free.push(id) };
    },
  };
}

async function verifyRecording(run, record) {
  try {
    await waitFor(
      "Recording",
      async () => {
        const listed = (await run.apiRequest("GET", `${run.tenantPath}/recordings?episode_id=${record.episodeId}`)).recordings[0];
        if (!listed) return false;
        const value = await run.apiRequest("GET", `${run.tenantPath}/recordings/${listed.id}`);
        check(!["failed", "expired"].includes(value.source.status), `Recording source ${value.source.status}`);
        return value.source.status === "available";
      },
      300_000,
      5000,
    );
  } catch (error) {
    record.findings.push(finding("recording_failed", String(error.message).slice(0, 160)));
  }
}

function checkTarget(config, options) {
  check(options.allowHosts.length > 0, "Pass --allow-host with the API host this run may use; the fleet never defaults to a target", "configuration");
  check(options.allowHosts.includes(new URL(config.api_url).hostname), "The proof configuration's API host is not in --allow-host", "configuration");
}

async function rotateKeys(run, retired, signal, createProofKey) {
  for (;;) {
    try {
      await sleep(keyRotationMs, undefined, { signal });
    } catch {
      return;
    }
    retired.push(run.ownership.keyId);
    await createProofKey(run);
  }
}

async function revokeRetired(run, retired) {
  for (const id of retired) await run.ownerRequest("DELETE", `${run.tenantPath}/api-keys/${id}`).catch((error) => check([404, 409].includes(error.status), "Retired proof key was not revoked"));
}

function printHeartbeat(calls) {
  const summary = summarizeFleet(calls);
  console.log(`FLEET done=${summary.calls} callHours=${summary.callHours} p1=${summary.p1} errored=${summary.erroredCalls} load=${(loadavg()[0] / cpus().length).toFixed(2)}`);
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  if (options.merge) return mergeRuns(options.files);
  if (options.envFile) process.loadEnvFile(options.envFile);
  const runId = process.env.CHALK_PROOF_RUN_ID ?? `${Date.now()}-${randomUUID()}`;
  const directory = resolve(".private", "prod-proof", runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  runLabel(runId);
  const startedAt = new Date().toISOString();
  const down = process.env.CHALK_CANARY_FAULT_DOWN;
  const up = process.env.CHALK_CANARY_FAULT_UP;
  const faults = !options.dryRun && options.faultIntervalMs > 0;
  check(!faults || (down && up), "Set CHALK_CANARY_FAULT_DOWN and CHALK_CANARY_FAULT_UP to commands that block and restore UDP to the media provider, or pass --fault-interval-seconds 0", "configuration");
  let installed = false;
  const shell = (script) => command("sh", ["-c", script]);
  const pulse = new FaultPulse({
    holdMs: options.faultMs,
    down: async () => {
      installed = true;
      await shell(down);
    },
    up: async () => {
      await shell(up);
      installed = false;
    },
  });
  pulse.configured = faults;
  const stop = new AbortController();
  const interrupted = (signal) => {
    stop.abort();
    if (installed) shell(up).catch(() => {});
    console.error(`${signal}: no new calls; waiting for running calls to end`);
  };
  process.once("SIGINT", () => interrupted("SIGINT"));
  process.once("SIGTERM", () => interrupted("SIGTERM"));

  const failures = {};
  const calls = [];
  const retired = [];
  const background = [];
  let run;
  try {
    if (options.dryRun) {
      await runScheduler({ options, calls, startCall: dryRunCall, pulse, signal: stop.signal, onFinished: () => {} });
    } else {
      const config = await loadConfig({ readiness: false });
      checkTarget(config, options);
      if (options.recordingFraction > 0) checkCapabilities(await request(config, "GET", "/readyz"));
      await sweepStaleRuns(config);
      // Only a real run needs the browser; a dry run and a merge load none of it.
      const [{ createProofKey, createSpace }, { proofServer }, { runCall }] = await Promise.all([import("./proofs.mjs"), import("./webhooks.mjs"), import("./fleet-call.mjs")]);
      run = await createRun(config, directory, undefined, runId);
      await createProofKey(run);
      const receiver = await proofServer(run);
      const ctx = { run, origin: receiver.origin, pulse, spaces: spacePool(run, options.spaceIds, createSpace), camera: options.camera };
      const onFinished = (record) => {
        if (record.recording && record.endedAt !== undefined) background.push(verifyRecording(run, record));
        for (const entry of record.findings.filter((candidate) => candidate.p1)) console.error(`P1 ${entry.reason} ${record.id}: ${entry.detail}`);
        printHeartbeat(calls);
      };
      const heartbeat = setInterval(() => printHeartbeat(calls), options.heartbeatMs);
      const rotation = new AbortController();
      const rotating = rotateKeys(run, retired, rotation.signal, createProofKey);
      try {
        await runScheduler({ options, calls, startCall: (spec) => runCall(ctx, spec), pulse, signal: stop.signal, onFinished });
      } finally {
        clearInterval(heartbeat);
        rotation.abort();
        await rotating;
      }
      await Promise.all(background);
    }
  } catch (error) {
    failures.run = errorEvidence(error);
    publicFailure("fleet", error);
  } finally {
    if (installed) await shell(up).catch(() => {});
    if (run) {
      await revokeRetired(run, retired).catch((error) => (failures.cleanup = errorEvidence(error)));
      await cleanupRun(run).catch((error) => (failures.cleanup = errorEvidence(error)));
    }
  }
  const summary = fleetSummary(options, calls, startedAt);
  if (failures.run || failures.cleanup) Object.assign(summary, { result: "failed", runError: Boolean(failures.run), cleanupError: Boolean(failures.cleanup) });
  await save(`${directory}/fleet-calls.json`, calls);
  await save(`${directory}/fleet-summary.json`, summary);
  if (failures.run || failures.cleanup) await save(`${directory}/fleet-failures.json`, failures);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`Private evidence: ${directory}`);
  if (summary.result !== "passed") process.exitCode = 1;
}

async function mergeRuns(files) {
  check(files.length > 0, "--merge needs the fleet-calls.json files of the machines", "configuration");
  const calls = (await Promise.all(files.map(async (file) => JSON.parse(await readFile(file, "utf8"))))).flat();
  console.log(JSON.stringify({ machines: files.length, ...summarizeFleet(calls) }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
