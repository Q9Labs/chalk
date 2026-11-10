#!/usr/bin/env node
// Live end-to-end scenarios for one media provider, driven by real SDK clients in headless Chromium.
//
//   CHALK_PROOF_MEDIA_PLANE=chalk_sfu pnpm prod:sfu-e2e ten publisher-leaves background
//
// Scenarios (default: all that need no outside command):
//   ten               ten clients with camera and microphone; every client receives media from every other
//   publisher-leaves  a publisher leaves mid-stream; the others drop it and keep their own media
//   background        the SDK sees a hidden tab (visibilitychange), then a visible one; media comes back without a manual toggle.
//                     Automated Chromium cannot make a tab natively hidden (tested: focus emulation, tab switch, minimize,
//                     lifecycle freeze), so this drives the SDK's visibility handling; native backgrounding is a manual pass.
//   audio             every client decodes the other clients' known tones (not only bytes); a muted client is silent at the others; unmuting brings the tone back
//   impair            CHALK_E2E_IMPAIR_DOWN / _UP run around a hold, as a tc loss or bandwidth cap; media keeps moving
//   node-restart      CHALK_E2E_RESTART runs mid-call; clients recover, by themselves or by an explicit rejoin
// Screen share, join and leave on two clients are covered by `pnpm prod:proof camera-share`.
// The report goes to .private/prod-proof/<run>/sfu-e2e-<provider>.json and the exit code is non-zero on any failure.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { check, command, createRun, errorEvidence, loadConfig, mediaPlane, publicFailure, save, waitFor } from "./runtime.mjs";
import { cleanupRun, runLabel, sweepStaleRuns } from "./cleanup.mjs";
import { launchGuests, stats } from "./media.mjs";
import { createSpace, episodeEnd, prepareIntegration } from "./proofs.mjs";
import { hearAfterUnmute, proveAudioDecoded, proveSilenceFrom, unheardAfterUnmute } from "./audio-decode.mjs";

const shell = (script) => command("sh", ["-c", script]);

const sameStream = (row) => (candidate) => candidate.id === row.id && candidate.connection === row.connection;

function advanced(row, was, kind) {
  if (!was || !(row.bytesReceived > was.bytesReceived)) return false;
  return kind !== "video" || row.framesDecoded > was.framesDecoded;
}

// Streams of one kind and source whose counters grew between two samples of one guest.
function moving(rows, before, kind, source) {
  const isStream = (row) => row.type === "inbound-rtp" && row.kind === kind && row.source === source;
  return rows.filter((row) => isStream(row) && advanced(row, before.find(sameStream(row)), kind)).length;
}

async function movement(pages, windowMs) {
  const before = await stats(pages);
  await sleep(windowMs);
  const after = await stats(pages);
  return after.map((rows, guest) => ({ cameras: moving(rows, before[guest], "video", "camera"), microphones: moving(rows, before[guest], "audio", "microphone") }));
}

// waitForMovement resolves with the time it took until every guest in `guests` receives at least `others` of each stream.
async function waitForMovement(pages, guests, others, limitMs, label) {
  const startedAt = performance.now();
  for (;;) {
    const seen = await movement(pages, 1500);
    if (guests.every((guest) => seen[guest].cameras >= others && seen[guest].microphones >= others)) return { ms: Math.round(performance.now() - startedAt), seen };
    check(performance.now() - startedAt < limitMs, `${label}: not every client received ${others} moving camera and microphone streams within ${limitMs} ms (last: ${JSON.stringify(seen)})`);
  }
}

async function openCall(run, receiver, guestCount) {
  const space = await createSpace(run);
  const episodePath = `${run.tenantPath}/spaces/${space.id}/episodes`;
  const episode = await run.apiRequest("POST", episodePath, { metadata: { proof_run_id: run.runId } });
  await save(`${run.directory}/episode.json`, episode);
  const ending = episodeEnd(run, `${episodePath}/${episode.id}`);
  const guests = await launchGuests(run, space, episode, null, receiver.origin, true, guestCount);
  ending.useSDK(guests.pages[0]);
  return { ...ending, guests };
}

const everyone = (count) => [...Array(count).keys()];
// Bytes advancing is not audio: the others must also decode each member's tone (audio-decode.mjs). The report keeps the dB and bin per pair.
const decoded = async (guests, members) => ({ audio: (await proveAudioDecoded(guests, { members })).map(({ listener, speaker, peakDb, floorDb, bin }) => ({ listener, speaker, peakDb, floorDb, bin })) });
const rosterSize = (page) => page.evaluate(() => window.proofClient.getSnapshot().participants.roster.length);

const scenarios = {
  async ten({ guests }) {
    const { pages } = guests;
    const joined = await waitForMovement(pages, everyone(10), 9, 60_000, "ten");
    return { ...joined, guests: 10, ...(await decoded(guests, everyone(10))) };
  },

  async "publisher-leaves"({ guests, useSDK }) {
    const { pages } = guests;
    await waitForMovement(pages, everyone(3), 2, 30_000, "before the leave");
    useSDK(pages[1]); // The page that leaves can no longer end the Episode.
    const leftAt = performance.now();
    await pages[0].evaluate(() => window.proofClient.leave());
    const leaver = guests.participants[0];
    // The roster shrinks and every remote track of the leaver is gone, while each survivor still holds the other's tracks.
    const remoteOwners = (page) => page.evaluate(() => window.proofClient.getSnapshot().media.remote.map((entry) => entry.participantId));
    await waitFor(
      "the others drop the publisher who left",
      async () => {
        const sizes = await Promise.all([rosterSize(pages[1]), rosterSize(pages[2])]);
        const owners = await Promise.all([remoteOwners(pages[1]), remoteOwners(pages[2])]);
        return sizes.every((size) => size === 2) && owners.every((ids) => !ids.includes(leaver));
      },
      30_000,
      500,
    );
    const dropMs = Math.round(performance.now() - leftAt);
    const rest = await waitForMovement(pages, [1, 2], 1, 30_000, "after the leave");
    const owners = await Promise.all([remoteOwners(pages[1]), remoteOwners(pages[2])]);
    check(owners[0].includes(guests.participants[2]) && owners[1].includes(guests.participants[1]), "A survivor lost the other survivor's media");
    return { dropMs, restMs: rest.ms, seen: rest.seen, ...(await decoded(guests, [1, 2])) };
  },

  async background({ guests }) {
    const { pages } = guests;
    await waitForMovement(pages, everyone(3), 2, 30_000, "before hiding");
    const hide = (hidden) =>
      pages[1].evaluate((state) => {
        Object.defineProperty(document, "visibilityState", { get: () => (state ? "hidden" : "visible"), configurable: true });
        Object.defineProperty(document, "hidden", { get: () => state, configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      }, hidden);
    await hide(true);
    await sleep(60_000);
    const whileHidden = await movement(pages, 5000);
    await hide(false);
    const back = await waitForMovement(pages, everyone(3), 2, 30_000, "after the tab came back");
    // Each of the others hears two microphones: the hidden guest and the other one.
    check(whileHidden[0].microphones >= 2 && whileHidden[2].microphones >= 2, "The others stopped hearing the hidden guest while its tab was hidden");
    return { emulatedVisibility: true, hiddenSeconds: 65, whileHidden, backMs: back.ms, ...(await decoded(guests, everyone(3))) };
  },

  // Tone in => tone detected at the other guests; then each guest in turn: mute => silence there; unmute (a re-publish) => the tone is back at every other guest.
  async audio({ guests }) {
    const { pages } = guests;
    await waitForMovement(pages, everyone(3), 2, 30_000, "before the audio check");
    const heard = await decoded(guests, everyone(3));
    const pick = ({ listener, speaker, peakDb, floorDb, bin, lastDb, track }) => ({ listener, speaker, peakDb, floorDb, bin, lastDb, track });
    const rounds = [];
    for (const speaker of everyone(3)) {
      await pages[speaker].evaluate(() => window.proofClient.media.setMicrophoneEnabled(false));
      const silenced = await proveSilenceFrom(guests, speaker);
      await pages[speaker].evaluate(() => window.proofClient.media.setMicrophoneEnabled(true));
      const back = await hearAfterUnmute(guests, speaker);
      const unheard = unheardAfterUnmute(speaker, back);
      check(unheard.length === 0, unheard.join("; "), "audio-not-decoded");
      rounds.push({ mutedGuest: speaker + 1, silence: silenced.map(pick), unmuted: back.map(pick) });
    }
    return { ...heard, rounds };
  },

  async impair({ guests }) {
    const { down, up } = impairment();
    const { pages } = guests;
    await waitForMovement(pages, everyone(3), 2, 30_000, "before the impairment");
    let held;
    try {
      await shell(down);
      await sleep(15_000);
      held = await movement(pages, 30_000);
    } finally {
      await shell(up);
    }
    // Under impairment the node and clients may drop quality, but every client must still receive some media.
    check(
      held.every((seen) => seen.microphones >= 1 && seen.cameras >= 1),
      `Media stopped under the impairment: ${JSON.stringify(held)}`,
    );
    const restored = await waitForMovement(pages, everyone(3), 2, 30_000, "after the impairment");
    return { held, restoredMs: restored.ms, ...(await decoded(guests, everyone(3))) };
  },

  async "node-restart"({ guests, useSDK }) {
    const restart = process.env.CHALK_E2E_RESTART;
    check(restart, "Set CHALK_E2E_RESTART to the command that restarts the media node", "configuration");
    const { pages } = guests;
    await waitForMovement(pages, everyone(3), 2, 30_000, "before the restart");
    const restartedAt = performance.now();
    await shell(restart);
    try {
      await waitForMovement(pages, everyone(3), 2, 90_000, "after the node restart");
      return { recovery: "by itself", ms: Math.round(performance.now() - restartedAt), ...(await decoded(guests, everyone(3))) };
    } catch {
      // The brief accepts an explicit rejoin after a node restart.
    }
    await guests.rejoinAll();
    useSDK(guests.pages[0]);
    const recovered = await waitForMovement(guests.pages, everyone(3), 2, 60_000, "after the explicit rejoin");
    return { recovery: "by explicit rejoin", ms: Math.round(performance.now() - restartedAt), seen: recovered.seen, ...(await decoded(guests, everyone(3))) };
  },
};

function impairment() {
  const { CHALK_E2E_IMPAIR_DOWN: down, CHALK_E2E_IMPAIR_UP: up } = process.env;
  check(down && up, "Set CHALK_E2E_IMPAIR_DOWN and CHALK_E2E_IMPAIR_UP to commands that apply and remove the impairment", "configuration");
  return { down, up };
}

const guestCounts = { ten: 10 };
const defaults = ["ten", "publisher-leaves", "background", "audio"];

const reason = (error) => (error instanceof Error ? error.message : String(error));

function scenarioNames() {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : defaults;
  for (const name of names) check(name in scenarios, `Unknown scenario ${name}`, "configuration");
  return names;
}

async function play(run, receiver, name) {
  let call;
  try {
    call = await openCall(run, receiver, guestCounts[name] ?? 3);
    return { call, outcome: { result: "passed", ...(await scenarios[name](call)) } };
  } catch (error) {
    return { call, outcome: { result: "failed", error: reason(error) } };
  }
}

// tearDown returns every failure to end the Episode or dispose a resource.
async function tearDown(run, call, mark) {
  const failures = [];
  if (call) await call.end().catch((error) => failures.push(`end Episode: ${reason(error)}`));
  for (const resource of run.resources.splice(mark)) await resource.dispose().catch((error) => failures.push(`dispose: ${reason(error)}`));
  return failures;
}

async function runScenario(run, receiver, name) {
  const mark = run.resources.length;
  const { call, outcome } = await play(run, receiver, name);
  const teardown = await tearDown(run, call, mark);
  return teardown.length ? { ...outcome, result: "failed", teardown } : outcome;
}

async function runScenarios(state, names, report) {
  const config = await loadConfig();
  await sweepStaleRuns(config);
  state.run = await createRun(config, state.directory, undefined, state.runId);
  const receiver = await prepareIntegration(state.run, false);
  for (const name of names) {
    report.scenarios[name] = await runScenario(state.run, receiver, name);
    console.log(`${name}: ${report.scenarios[name].result}`);
  }
}

const allPassed = (report) => !report.error && !report.cleanupError && Object.values(report.scenarios).every((scenario) => scenario.result === "passed");

async function finish(directory, report) {
  report.result = allPassed(report) ? "passed" : "failed";
  await save(`${directory}/sfu-e2e-${mediaPlane}.json`, report);
  console.log(JSON.stringify(report, null, 2));
  console.log(`Private evidence: ${directory}`);
  if (report.result !== "passed") process.exitCode = 1;
}

async function main() {
  const names = scenarioNames();
  const runId = process.env.CHALK_PROOF_RUN_ID ?? `${Date.now()}-${randomUUID()}`;
  runLabel(runId);
  const state = { runId, directory: resolve(".private", "prod-proof", runId) };
  await mkdir(state.directory, { recursive: true, mode: 0o700 });
  const report = { provider: mediaPlane, startedAt: new Date().toISOString(), scenarios: {} };
  try {
    await runScenarios(state, names, report);
  } catch (error) {
    report.error = errorEvidence(error);
    publicFailure("sfu-e2e", error);
  } finally {
    if (state.run) await cleanupRun(state.run).catch((error) => (report.cleanupError = errorEvidence(error)));
  }
  await finish(state.directory, report);
}

await main();
