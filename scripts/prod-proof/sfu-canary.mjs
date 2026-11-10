#!/usr/bin/env node
// Scripted join and short-fault trials on one media provider: the M7 canary check.
//
//   CHALK_PROOF_MEDIA_PLANE=chalk_sfu \
//   CHALK_CANARY_FAULT_DOWN='sudo iptables -I OUTPUT -p udp -d <media address> -j DROP' \
//   CHALK_CANARY_FAULT_UP='sudo iptables -D OUTPUT -p udp -d <media address> -j DROP' \
//   node scripts/prod-proof/sfu-canary.mjs [--joins 20] [--faults 10] [--fault-seconds 5]
//
// Run it once per provider with the same flags and the same machine, so the two
// result files compare under a matched network and call shape. Every trial joins two
// real SDK clients in headless Chromium with generated camera and tones. A join is
// rendered when both clients decode advancing video and receive advancing audio.
// A fault trial runs the DOWN command, proves that no camera video moved, runs the UP
// command, and measures how long both directions take to render again, once with
// the first client's microphone on and once muted. Playwright's offline mode does not
// stop established WebRTC media, so the fault is a command that blocks the media
// path; both clients share the machine, so both lose it. The run fails when any join
// (fault trials included) takes more than 10 s, a fault takes more than 15 s to
// recover, the fault did not stall media, or recovery turns the muted microphone on.
// meetsM7Minimum in the report says whether the run had 20 joins and 10 faults.
// --faults 0 runs joins only, with no fault commands: a post-deploy smoke of a media node.
// CHALK_CANARY_SPACE_ID reuses one existing Space, as an allowlisted production Space
// needs, instead of creating a Space for each trial.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { check, command, createRun, errorEvidence, loadConfig, mediaPlane, publicFailure, save } from "./runtime.mjs";
import { cleanupRun, runLabel, sweepStaleRuns } from "./cleanup.mjs";
import { launchGuests, stats } from "./media.mjs";
import { proveAudioDecoded, proveSilenceFrom } from "./audio-decode.mjs";
import { createSpace, episodeEnd, prepareIntegration } from "./proofs.mjs";
import { grew, rendering, stalled, summarize } from "./sfu-canary-criteria.mjs";

const options = parseArgs({
  options: {
    joins: { type: "string", default: "20" },
    faults: { type: "string", default: "10" },
    "fault-seconds": { type: "string", default: "5" },
    "join-limit-ms": { type: "string", default: "10000" },
    "recovery-limit-ms": { type: "string", default: "15000" },
  },
}).values;
const joins = Number(options.joins);
const faults = Number(options.faults);
const faultMs = Number(options["fault-seconds"]) * 1000;
const joinLimitMs = Number(options["join-limit-ms"]);
const recoveryLimitMs = Number(options["recovery-limit-ms"]);
const pollMs = 500;
const stallProbeMs = 1500;
const faultDown = process.env.CHALK_CANARY_FAULT_DOWN;
const faultUp = process.env.CHALK_CANARY_FAULT_UP;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const shell = (script) => command("sh", ["-c", script]);

async function rendersWithin(pages, startedAt, limitMs, label) {
  let previous = await stats(pages);
  for (;;) {
    await sleep(pollMs);
    const current = await stats(pages);
    if (rendering(current, previous)) return Math.round(performance.now() - startedAt);
    previous = current;
    check(performance.now() - startedAt < limitMs + 15_000, `${label}: no rendered audio and video within ${limitMs + 15_000} ms`);
  }
}

async function microphoneState(page) {
  return page.evaluate(() => window.proofClient.getSnapshot().media.local.microphone.state);
}

// openCall records the Episode's owner in `owned` before any guest launches, so a failed setup can still end it.
async function openCall(run, receiver, owned) {
  const space = process.env.CHALK_CANARY_SPACE_ID ? await run.apiRequest("GET", `${run.tenantPath}/spaces/${process.env.CHALK_CANARY_SPACE_ID}`) : await createSpace(run);
  check(space.media_plane === mediaPlane, `Space uses ${space.media_plane}, not ${mediaPlane}`);
  await save(`${run.directory}/space.json`, space);
  const episodePath = `${run.tenantPath}/spaces/${space.id}/episodes`;
  const episode = await run.apiRequest("POST", episodePath, { metadata: { proof_run_id: run.runId } });
  owned.path = `${episodePath}/${episode.id}`;
  owned.ending = episodeEnd(run, owned.path);
  await save(`${run.directory}/episode.json`, episode);
  let startedAt = performance.now();
  // Guests launch one after the other, and the first cannot receive media before the second joins. A join is timed
  // from the second guest's SDK join call, so browser startup and admission of either guest are outside it.
  const guests = await launchGuests(run, space, episode, null, receiver.origin, true, 2, { onJoinStart: (guest, at) => guest === 1 && (startedAt = at) });
  owned.ending.useSDK(guests.pages[0]);
  return { guests, startedAt };
}

// True from the start of the fault command until the restore command ends, so an interrupt can restore the path.
let faultInstalled = false;

function restoreOnInterrupt(signal) {
  if (faultInstalled) spawnSync("sh", ["-c", faultUp], { stdio: "inherit" });
  process.exit(signal === "SIGINT" ? 130 : 143);
}

async function faultRound(pages, muted) {
  if (muted) await pages[0].evaluate(() => window.proofClient.media.setMicrophoneEnabled(false));
  let restoredAt;
  try {
    faultInstalled = true;
    await shell(faultDown);
    await sleep(faultMs - stallProbeMs);
    const before = await stats(pages);
    await sleep(stallProbeMs);
    check(stalled(await stats(pages), before), "The fault did not interrupt rendered media");
  } finally {
    // Recovery counts from the start of the restore command, which may keep running after the path is back.
    restoredAt = performance.now();
    await shell(faultUp);
    faultInstalled = false;
  }
  if (!muted) return rendersWithin(pages, restoredAt, recoveryLimitMs, "recovery");
  const recovered = await mutedRendersWithin(pages, restoredAt, recoveryLimitMs);
  check((await microphoneState(pages[0])) !== "enabled", "Recovery turned a muted microphone back on");
  return recovered;
}

// endEpisode ends the trial's Episode through the SDK, then through the owner API. A reused Space is outside
// the run-wide cleanup, so a failure here is returned and fails the trial.
async function endEpisode(run, owned) {
  if (!owned.ending) return undefined;
  try {
    await owned.ending.end();
    return undefined;
  } catch {
    try {
      await episodeEnd(run, owned.path).end();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}

async function trial(run, receiver, fault) {
  const mark = run.resources.length;
  const owned = {};
  let result;
  try {
    const call = await openCall(run, receiver, owned);
    const { pages } = call.guests;
    const joinMs = await rendersWithin(pages, call.startedAt, joinLimitMs, "join");
    // The timings above are settled; now the audio must also decode (a tone at the other client), not only advance in bytes.
    await proveAudioDecoded(call.guests);
    if (!fault) result = { ms: joinMs };
    else {
      const open = await faultRound(pages, false);
      await proveAudioDecoded(call.guests);
      const muted = await faultRound(pages, true);
      // The muted client stays silent at the other; the other's tone still reaches it.
      await proveSilenceFrom(call.guests, 0);
      await proveAudioDecoded(call.guests, { pairs: [{ listener: 0, speaker: 1 }] });
      const recoveries = [open, muted];
      result = { ms: Math.max(...recoveries), joinMs, recoveries };
    }
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  const teardownError = await endEpisode(run, owned);
  for (const resource of run.resources.splice(mark)) await resource.dispose().catch(() => {});
  return teardownError === undefined ? result : { error: result.error ?? `The trial's Episode did not end: ${teardownError}` };
}

// The muted client sends no audio, so the other client's audio must reach it and video must reach both.
async function mutedRendersWithin(pages, startedAt, limitMs) {
  let previous = await stats(pages);
  for (;;) {
    await sleep(pollMs);
    const current = await stats(pages);
    const video = current.every((rows, guest) => grew(rows, previous[guest], "video", "camera"));
    if (video && grew(current[0], previous[0], "audio", "microphone")) return Math.round(performance.now() - startedAt);
    previous = current;
    check(performance.now() - startedAt < limitMs + 15_000, "muted recovery: no rendered video and audio");
  }
}

function checkConfiguration() {
  check(Number.isInteger(joins) && joins >= 1 && Number.isInteger(faults) && faults >= 0, "--joins must be at least 1 and --faults at least 0", "configuration");
  if (faults === 0) return;
  check(faultMs > stallProbeMs + 1000, "--fault-seconds is too short to prove an interruption", "configuration");
  check(faultDown && faultUp, "Set CHALK_CANARY_FAULT_DOWN and CHALK_CANARY_FAULT_UP to commands that block and restore UDP to the media provider", "configuration");
}

// A fault trial also joins, so its join counts against the join limit.
function conclude(report) {
  const faultJoins = report.faults.map((trial) => (trial.joinMs === undefined ? trial : { ms: trial.joinMs }));
  report.summary = { join: summarize([...report.joins, ...faultJoins], joinLimitMs), recovery: summarize(report.faults, recoveryLimitMs) };
  report.meetsM7Minimum = joins >= 20 && faults >= 10;
  const { join, recovery } = report.summary;
  report.result = !report.error && !report.cleanupError && join.withinLimit === join.trials && recovery.withinLimit === recovery.trials ? "passed" : "failed";
}

async function main() {
  process.once("SIGINT", restoreOnInterrupt);
  process.once("SIGTERM", restoreOnInterrupt);
  const runId = process.env.CHALK_PROOF_RUN_ID ?? `${Date.now()}-${randomUUID()}`;
  runLabel(runId);
  const directory = resolve(".private", "prod-proof", runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = { provider: mediaPlane, startedAt: new Date().toISOString(), flags: { joins, faults, faultSeconds: faultMs / 1000, joinLimitMs, recoveryLimitMs }, joins: [], faults: [] };
  let run;
  try {
    checkConfiguration();
    const config = await loadConfig();
    await sweepStaleRuns(config);
    run = await createRun(config, directory, undefined, runId);
    const receiver = await prepareIntegration(run, false);
    for (let index = 0; index < joins; index++) report.joins.push(await trial(run, receiver, false));
    for (let index = 0; index < faults; index++) report.faults.push(await trial(run, receiver, true));
  } catch (error) {
    report.error = errorEvidence(error);
    publicFailure("sfu-canary", error);
  } finally {
    if (run) await cleanupRun(run).catch((error) => (report.cleanupError = errorEvidence(error)));
  }
  conclude(report);
  await save(`${directory}/sfu-canary-${mediaPlane}.json`, report);
  console.log(JSON.stringify({ provider: mediaPlane, result: report.result, meetsM7Minimum: report.meetsM7Minimum, ...report.summary }, null, 2));
  console.log(`Private evidence: ${directory}`);
  if (report.result !== "passed") process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
