#!/usr/bin/env node
// Scripted join and short-fault trials on one media provider: the M7 canary check.
//
//   CHALK_PROOF_MEDIA_PLANE=chalk_sfu node scripts/prod-proof/sfu-canary.mjs [--joins 20] [--faults 10] [--fault-seconds 5]
//
// Run it once per provider with the same flags and the same machine, so the two
// result files compare under a matched network and call shape. Every trial joins two
// real SDK clients in headless Chromium with generated camera and tones. A join is
// rendered when both clients decode advancing video and receive advancing audio.
// A fault trial takes one client offline, restores it, and measures how long both
// directions take to render again. The run fails when a join takes more than 10 s,
// a fault takes more than 15 s to recover, or a muted client is unmuted by recovery.
// CHALK_CANARY_SPACE_ID reuses one existing Space, as an allowlisted production Space
// needs, instead of creating a Space for each trial.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { check, createRun, errorEvidence, loadConfig, mediaPlane, publicFailure, save } from "./runtime.mjs";
import { cleanupRun, runLabel, sweepStaleRuns } from "./cleanup.mjs";
import { launchGuests, stats } from "./media.mjs";
import { createSpace, episodeEnd, prepareIntegration } from "./proofs.mjs";
import { grew, rendering, summarize } from "./sfu-canary-criteria.mjs";

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

async function rendersWithin(pages, startedAt, limitMs, label) {
  let previous = await stats(pages);
  for (;;) {
    await new Promise((done) => setTimeout(done, pollMs));
    const current = await stats(pages);
    if (rendering(current, previous)) return Math.round(performance.now() - startedAt);
    previous = current;
    check(performance.now() - startedAt < limitMs + 15_000, `${label}: no rendered audio and video within ${limitMs + 15_000} ms`);
  }
}

async function microphoneState(page) {
  return page.evaluate(() => window.proofClient.getSnapshot().media.local.microphone.state);
}

async function openCall(run, receiver) {
  const space = process.env.CHALK_CANARY_SPACE_ID ? await run.apiRequest("GET", `${run.tenantPath}/spaces/${process.env.CHALK_CANARY_SPACE_ID}`) : await createSpace(run);
  check(space.media_plane === mediaPlane, `Space uses ${space.media_plane}, not ${mediaPlane}`);
  await save(`${run.directory}/space.json`, space);
  const episodePath = `${run.tenantPath}/spaces/${space.id}/episodes`;
  const episode = await run.apiRequest("POST", episodePath, { metadata: { proof_run_id: run.runId } });
  await save(`${run.directory}/episode.json`, episode);
  const ending = episodeEnd(run, `${episodePath}/${episode.id}`);
  let startedAt = performance.now();
  // A join starts when the last guest calls the SDK join, not when its browser launches.
  const guests = await launchGuests(run, space, episode, null, receiver.origin, true, 2, { onJoinStart: (_guest, at) => (startedAt = at) });
  ending.useSDK(guests.pages[0]);
  return { ...ending, guests, startedAt };
}

async function trial(run, receiver, fault) {
  const mark = run.resources.length;
  let call;
  try {
    call = await openCall(run, receiver);
    const { pages } = call.guests;
    const joinMs = await rendersWithin(pages, call.startedAt, joinLimitMs, "join");
    if (!fault) return { ms: joinMs };
    const context = pages[0].context();
    const recoveries = [];
    for (const muted of [false, true]) {
      if (muted) await pages[1].evaluate(() => window.proofClient.media.setMicrophoneEnabled(false));
      await context.setOffline(true);
      await new Promise((done) => setTimeout(done, faultMs));
      await context.setOffline(false);
      const restoredAt = performance.now();
      // A muted client sends no audio, so the muted round proves video and that the mute held.
      const recovered = muted ? await videoRendersWithin(pages, restoredAt, recoveryLimitMs) : await rendersWithin(pages, restoredAt, recoveryLimitMs, "recovery");
      if (muted) check((await microphoneState(pages[1])) !== "enabled", "Recovery turned a muted microphone back on");
      recoveries.push(recovered);
    }
    return { ms: Math.max(...recoveries), joinMs, recoveries, muteKept: true };
  } catch (error) {
    return { error: errorEvidence(error).message ?? "failed" };
  } finally {
    if (call) await call.end().catch(() => {});
    for (const resource of run.resources.splice(mark)) await resource.dispose().catch(() => {});
  }
}

async function videoRendersWithin(pages, startedAt, limitMs) {
  let previous = await stats(pages);
  for (;;) {
    await new Promise((done) => setTimeout(done, pollMs));
    const current = await stats(pages);
    if (current.every((rows, guest) => grew(rows, previous[guest], "video", "camera"))) return Math.round(performance.now() - startedAt);
    previous = current;
    check(performance.now() - startedAt < limitMs + 15_000, "muted recovery: no rendered video");
  }
}

async function main() {
  const runId = process.env.CHALK_PROOF_RUN_ID ?? `${Date.now()}-${randomUUID()}`;
  runLabel(runId);
  const directory = resolve(".private", "prod-proof", runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = { provider: mediaPlane, startedAt: new Date().toISOString(), flags: { joins, faults, faultSeconds: faultMs / 1000, joinLimitMs, recoveryLimitMs }, joins: [], faults: [] };
  let run;
  try {
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
  report.summary = { join: summarize(report.joins, joinLimitMs), recovery: summarize(report.faults, recoveryLimitMs) };
  const passed = !report.error && !report.cleanupError && report.summary.join.withinLimit === joins && report.summary.recovery.withinLimit === faults;
  report.result = passed ? "passed" : "failed";
  await save(`${directory}/sfu-canary-${mediaPlane}.json`, report);
  console.log(JSON.stringify({ provider: mediaPlane, result: report.result, ...report.summary }, null, 2));
  console.log(`Private evidence: ${directory}`);
  if (!passed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
