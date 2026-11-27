#!/usr/bin/env node
// Production proof that a call running past its booking window keeps its window node. One booked class and several filler
// classes, each guest a headless Chromium with a fake camera and microphone, on the production API. The booking pre-warms window
// nodes; the fillers use up the standing nodes' room so the booked class lands on a window node. The fillers end before the
// booking does and the booked class runs on past its expected end, so for the overrun the controller has no demand left and the
// node stays only because a live Episode is bound to it. The script prints the times an operator needs to read the controller
// journal (plan lines, draining and deletion) and the Axiom rows of the window node for the booked Episode.
//
//   CHALK_PROOF_CONFIG_SOURCE=env CHALK_PROOF_API_KEY=... (as autoscale-load.mjs) \
//     node scripts/prod-proof/window-overrun.mjs --expect-api-host api.chalkmeet.com --fillers 6 --guests 2 \
//       --booking-start-minutes 3 --booking-minutes 3 --overrun-minutes 5 --filler-minutes 5
//
// Times are minutes after the start the plan line prints. The controller's STANDING_SLOTS must be low (1) and no other Episode
// or booking may be live. The output holds run identifiers, so keep it out of Git.
import { mkdir, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { advancedStreams } from "./class-window-judge.mjs";

const sampleMs = 10_000;
const rampMs = 90_000;
const liveTimeoutMs = 240_000;
const minute = 60_000;

const { values } = parseArgs({
  options: {
    "expect-api-host": { type: "string" },
    fillers: { type: "string", default: "6" },
    guests: { type: "string", default: "2" },
    "booking-start-minutes": { type: "string", default: "3" },
    "booking-minutes": { type: "string", default: "3" },
    "overrun-minutes": { type: "string", default: "5" },
    "filler-minutes": { type: "string", default: "5" },
    out: { type: "string" },
  },
});
const fail = (message) => {
  console.error("window-overrun: " + message);
  process.exit(2);
};
const whole = (raw, name) => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) fail(name + " must be a positive whole number");
  return value;
};
if (process.env.CHALK_PROOF_CONFIG_SOURCE !== "env") fail("set CHALK_PROOF_CONFIG_SOURCE=env");
if (new URL(process.env.CHALK_PROOF_API_URL ?? "http://invalid").host !== values["expect-api-host"]) fail("the configured API host is not --expect-api-host");
const fillers = whole(values.fillers, "--fillers");
const guestCount = whole(values.guests, "--guests");
const bookingStart = whole(values["booking-start-minutes"], "--booking-start-minutes") * minute;
const bookingLength = whole(values["booking-minutes"], "--booking-minutes") * minute;
const overrun = whole(values["overrun-minutes"], "--overrun-minutes") * minute;
const fillerLength = whole(values["filler-minutes"], "--filler-minutes") * minute;
if (guestCount < 2 || guestCount > 3) fail("--guests must be 2 or 3, so each class is one slot to the controller");
if (fillerLength >= bookingStart + bookingLength) fail("the fillers must end before the booking does, or the overrun has demand to keep the node");
if (bookingStart + bookingLength + overrun > 40 * minute) fail("finish within the proof key's lifetime");
const out = resolve(values.out ?? ".private/window-overrun/" + new Date().toISOString().replace(/[:.]/g, "-"));

const { loadConfig, createRun, errorEvidence, save, publicFailure, waitFor } = await import("./runtime.mjs");
const { cleanupRun } = await import("./cleanup.mjs");
const { prepareIntegration, createProofKey, createSpace, openEpisodeInSpace, episodeEnd } = await import("./proofs.mjs");
const { launchGuests, stats } = await import("./media.mjs");
const { manualPolicy } = await import("./space-fixture.mjs");

await mkdir(out, { recursive: true, mode: 0o700 });
const config = await loadConfig({ capabilities: false });
const controller = new AbortController();
const signal = controller.signal;
process.once("SIGINT", () => controller.abort(new Error("Interrupted")));
process.once("SIGTERM", () => controller.abort(new Error("Interrupted")));
const shardRun = await createRun(config, resolve(out, "shard"), signal, "wo-" + randomUUID().slice(0, 8));
const startedAt = Date.now() + 2 * minute;
const bookingStartsAt = startedAt + bookingStart;
const bookingEndsAt = bookingStartsAt + bookingLength;
const bookedEndAt = bookingEndsAt + overrun;
const iso = (at) => new Date(at).toISOString();
console.log(JSON.stringify({ event: "plan", startedAt: iso(startedAt), fillersEnd: iso(startedAt + fillerLength), bookingStartsAt: iso(bookingStartsAt), bookingEndsAt: iso(bookingEndsAt), bookedEndAt: iso(bookedEndAt), fillers, guestCount }));

let cleanupFailed = false;
const verdicts = [];
try {
  const { origin } = await prepareIntegration(shardRun, false);
  const classes = [
    ...Array.from({ length: fillers }, (_, index) => ({ index, booked: false, joinAt: startedAt, endAt: startedAt + fillerLength })),
    { index: fillers, booked: true, joinAt: bookingStartsAt, endAt: bookedEndAt },
  ];
  const settled = await Promise.allSettled(classes.map((entry) => runClass(origin, entry)));
  settled.forEach((result, offset) => verdicts.push(result.status === "fulfilled" ? result.value : { class: classes[offset].index, pass: false, reason: "class-crashed" }));
} finally {
  await cleanupRun(shardRun).catch((error) => {
    cleanupFailed = true;
    publicFailure("shard cleanup", error);
  });
}
const failed = verdicts.filter((verdict) => !verdict.pass).map((verdict) => verdict.class);
const verdict = { startedAt: iso(startedAt), bookingStartsAt: iso(bookingStartsAt), bookingEndsAt: iso(bookingEndsAt), bookedEndAt: iso(bookedEndAt), classes: verdicts.length, passed: verdicts.length - failed.length, failed, cleanupFailed, pass: verdicts.length > 0 && failed.length === 0 && !cleanupFailed, verdicts };
await save(resolve(out, "verdict.json"), verdict);
console.log("window-overrun: " + verdict.passed + "/" + verdict.classes + " classes passed" + (failed.length ? "; failed " + failed.join(",") : ""));
if (!verdict.pass) process.exitCode = 1;

async function runClass(origin, { index, booked, joinAt, endAt }) {
  const directory = resolve(out, "class-" + index);
  const run = await createRun(config, directory, signal, shardRun.runId + "-k" + index);
  let result;
  let bookingPath;
  try {
    await createProofKey(run);
    const space = await createSpace(run, manualPolicy, { reuse: false, episodeDurationSeconds: Math.ceil((endAt - Date.now()) / 1000) + 900 });
    if (booked) {
      bookingPath = run.tenantPath + "/spaces/" + space.id + "/scheduled-episodes/" + randomUUID();
      await run.apiRequest("PUT", bookingPath, { starts_at: iso(bookingStartsAt), expected_ends_at: iso(bookingEndsAt), expected_participants: Array.from({ length: guestCount }, (_, guest) => ({ name: "Guest " + (guest + 1) })), metadata: { proof_run_id: run.runId } });
      console.log(JSON.stringify({ event: "booking-created", at: new Date().toISOString() }));
    }
    await until(joinAt);
    const { episode } = await openEpisodeInSpace(run, space);
    const ending = episodeEnd(run, run.tenantPath + "/spaces/" + space.id + "/episodes/" + episode.id);
    await save(resolve(directory, "episode.json"), { episode: episode.id, space: space.id, booked, openedAt: new Date().toISOString() });
    if (booked) console.log(JSON.stringify({ event: "booked-episode", episode: episode.id, openedAt: new Date().toISOString() }));
    const guests = await launchGuests(run, space, episode, null, origin, true, guestCount);
    await waitFor("class " + index + " live", () => allLive(guests.pages, guestCount), liveTimeoutMs, 2000, signal);
    const samples = await hold(guests.pages, resolve(directory, "samples.jsonl"), endAt, Date.now());
    ending.useSDK(guests.pages[0]);
    if (booked) console.log(JSON.stringify({ event: "booked-ending", at: new Date().toISOString() }));
    await ending.end();
    if (booked) console.log(JSON.stringify({ event: "booked-ended", at: new Date().toISOString() }));
    result = { class: index, booked, ...judge(samples) };
  } catch (error) {
    publicFailure("class " + index, error);
    await save(resolve(directory, "error.json"), errorEvidence(error)).catch(() => {});
    result = { class: index, booked, pass: false, reason: "class-failed" };
  } finally {
    if (bookingPath) await run.apiRequest("DELETE", bookingPath).catch((error) => publicFailure("class " + index + " booking delete", error));
    await cleanupRun(run).catch((error) => {
      publicFailure("class " + index + " cleanup", error);
      if (result) {
        result.pass = false;
        result.cleanupFailed = true;
      }
    });
  }
  await save(resolve(directory, "verdict.json"), result);
  return result;
}

async function allLive(pages, count) {
  for (const page of pages) {
    const live = await page.evaluate((expected) => {
      const snapshot = window.proofClient.getSnapshot();
      return snapshot.connection.status === "live" && snapshot.participants.roster.length === expected && snapshot.media.local.microphone.state === "enabled" && snapshot.media.local.camera.state === "enabled";
    }, count);
    if (!live) return false;
  }
  return true;
}

async function hold(pages, file, endAt, joinAt) {
  const samples = [];
  for (let at = Math.ceil(Date.now() / sampleMs) * sampleMs; at <= endAt; at += sampleMs) {
    await until(at);
    const rows = await stats(pages);
    const sample = { at: iso(at), sinceJoinMs: at - joinAt, guests: rows.map(cameraInbound) };
    samples.push(sample);
    await appendFile(file, JSON.stringify(sample) + "\n", { mode: 0o600 });
  }
  return samples;
}

function judge(samples) {
  const windows = [];
  for (let index = 1; index < samples.length; index++) {
    if (samples[index].sinceJoinMs < rampMs) continue;
    const ok = samples[index].guests.every((rows, guest) => advancedStreams(samples[index - 1].guests[guest], rows, (row) => row.source === "camera") >= guestCount - 1);
    windows.push({ at: samples[index].at, ok });
  }
  const bad = windows.filter((window) => !window.ok);
  return { windows: windows.length, failedWindows: bad.length, firstFailureAt: bad[0]?.at ?? null, pass: windows.length > 0 && bad.length === 0 };
}

function cameraInbound(rows) {
  return rows.filter((row) => row.type === "inbound-rtp" && row.kind === "video").map(({ type, kind, source, id, connection, framesDecoded }) => ({ type, kind, source, id, connection, framesDecoded }));
}

async function until(atMs) {
  await delay(Math.max(0, atMs - Date.now()), undefined, { signal });
}
