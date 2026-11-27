#!/usr/bin/env node
// Live-load proof for the SFU window controller: two waves of small classes, each guest a headless Chromium with a fake
// camera and microphone, on the production API. Wave 1 pushes live slots past what the controller counts as standing, so it
// provisions window nodes. Wave 2 starts after the nodes are ready and should land on them. Every class is sampled
// every 10 s; a class passes when each guest decoded a camera stream from every other guest in every window after the ramp.
//
//   CHALK_PROOF_CONFIG_SOURCE=env CHALK_PROOF_API_KEY=... CHALK_PROOF_TENANT_ID=... CHALK_PROOF_API_URL=... \
//     CHALK_PROOF_WEB_URL=... CHALK_PROOF_PROOF_ORIGIN=... CHALK_PROOF_WEBHOOK_SERVICE_URL=... CHALK_PROOF_WEBHOOK_ENDPOINT_ID=... \
//     node scripts/prod-proof/autoscale-load.mjs --expect-api-host api.chalkmeet.com --wave1 5 --wave2 3 --guests 2 \
//       --wave2-after-minutes 6 --hold-minutes 16 [--out DIR]
//
// It writes samples.jsonl and verdict.json per class under --out. The output holds run identifiers, so keep it out of Git.
import { mkdir, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { advancedStreams } from "./class-window-judge.mjs";

const sampleMs = 10_000;
const rampMs = 90_000;
const liveTimeoutMs = 240_000;

const { values } = parseArgs({
  options: {
    "expect-api-host": { type: "string" },
    wave1: { type: "string", default: "5" },
    wave2: { type: "string", default: "3" },
    guests: { type: "string", default: "2" },
    "wave2-after-minutes": { type: "string", default: "6" },
    "hold-minutes": { type: "string", default: "16" },
    out: { type: "string" },
  },
});

const fail = (message) => {
  console.error(`autoscale-load: ${message}`);
  process.exit(2);
};
const whole = (raw, name) => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) fail(`${name} must be a whole number`);
  return value;
};
if (process.env.CHALK_PROOF_CONFIG_SOURCE !== "env") fail("set CHALK_PROOF_CONFIG_SOURCE=env");
if (new URL(process.env.CHALK_PROOF_API_URL ?? "http://invalid").host !== values["expect-api-host"]) fail("the configured API host is not --expect-api-host");
const wave1 = whole(values.wave1, "--wave1");
const wave2 = whole(values.wave2, "--wave2");
const guestCount = whole(values.guests, "--guests");
const wave2At = whole(values["wave2-after-minutes"], "--wave2-after-minutes") * 60_000;
const holdMs = whole(values["hold-minutes"], "--hold-minutes") * 60_000;
if (guestCount < 2 || guestCount > 3) fail("--guests must be 2 or 3, so each class is one slot to the controller");
if (holdMs <= wave2At + liveTimeoutMs) fail("--hold-minutes must outlast the second wave's ramp");
if (holdMs > 50 * 60_000) fail("finish within the proof key's lifetime");
const out = resolve(values.out ?? `.private/autoscale-load/${new Date().toISOString().replace(/[:.]/g, "-")}`);

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
const shardRun = await createRun(config, resolve(out, "shard"), signal, `al-${randomUUID().slice(0, 8)}`);
const startedAt = Date.now() + 5_000;
const endAt = startedAt + holdMs;
console.log(JSON.stringify({ event: "plan", startedAt: new Date(startedAt).toISOString(), wave2At: new Date(startedAt + wave2At).toISOString(), endAt: new Date(endAt).toISOString(), wave1, wave2, guestCount }));
let cleanupFailed = false;
const verdicts = [];
try {
  const { origin } = await prepareIntegration(shardRun, false);
  const classes = [...Array.from({ length: wave1 }, (_, index) => ({ index, wave: 1, joinAt: startedAt })), ...Array.from({ length: wave2 }, (_, offset) => ({ index: wave1 + offset, wave: 2, joinAt: startedAt + wave2At }))];
  const settled = await Promise.allSettled(classes.map((entry) => runClass(origin, entry)));
  settled.forEach((result, offset) => verdicts.push(result.status === "fulfilled" ? result.value : { class: classes[offset].index, wave: classes[offset].wave, pass: false, reason: "class-crashed" }));
} finally {
  await cleanupRun(shardRun).catch((error) => {
    cleanupFailed = true;
    publicFailure("shard cleanup", error);
  });
}
const failed = verdicts.filter((verdict) => !verdict.pass).map((verdict) => verdict.class);
const verdict = { startedAt: new Date(startedAt).toISOString(), endAt: new Date(endAt).toISOString(), wave1, wave2, guestCount, classes: verdicts.length, passed: verdicts.length - failed.length, failed, cleanupFailed, pass: verdicts.length > 0 && failed.length === 0 && !cleanupFailed, verdicts };
await save(resolve(out, "verdict.json"), verdict);
console.log(`autoscale-load: ${verdict.passed}/${verdict.classes} classes passed${failed.length ? `; failed ${failed.join(",")}` : ""}`);
if (!verdict.pass) process.exitCode = 1;

async function runClass(origin, { index, wave, joinAt }) {
  const directory = resolve(out, `class-${index}`);
  const run = await createRun(config, directory, signal, `${shardRun.runId}-k${index}`);
  let result;
  try {
    await createProofKey(run);
    const space = await createSpace(run, manualPolicy, { reuse: false, episodeDurationSeconds: Math.ceil((endAt - Date.now()) / 1000) + 900 });
    await until(joinAt);
    const openingStarted = performance.now();
    const { episode } = await openEpisodeInSpace(run, space);
    const openEpisodeMs = Math.round(performance.now() - openingStarted);
    const ending = episodeEnd(run, `${run.tenantPath}/spaces/${space.id}/episodes/${episode.id}`);
    await save(resolve(directory, "episode.json"), { episode: episode.id, space: space.id, wave, openedAt: new Date().toISOString() });
    const joiningStarted = performance.now();
    const guests = await launchGuests(run, space, episode, null, origin, true, guestCount);
    await waitFor(`class ${index} live`, () => allLive(guests.pages, guestCount), liveTimeoutMs, 2000, signal);
    const mediaLiveMs = Math.round(performance.now() - joiningStarted);
    const samples = await hold(guests.pages, resolve(directory, "samples.jsonl"), Date.now());
    ending.useSDK(guests.pages[0]);
    await ending.end();
    result = { class: index, wave, openEpisodeMs, mediaLiveMs, ...judge(samples) };
  } catch (error) {
    publicFailure(`class ${index}`, error);
    await save(resolve(directory, "error.json"), errorEvidence(error)).catch(() => {});
    result = { class: index, wave, pass: false, reason: "class-failed" };
  } finally {
    await cleanupRun(run).catch((error) => {
      publicFailure(`class ${index} cleanup`, error);
      if (result) {
        result.pass = false;
        result.cleanupFailed = true;
      }
    });
  }
  await save(resolve(directory, "verdict.json"), result);
  return result;
}

async function hold(pages, file, joinAt) {
  const samples = [];
  for (let at = Math.ceil(Date.now() / sampleMs) * sampleMs; at <= endAt; at += sampleMs) {
    await until(at);
    const rows = await stats(pages);
    const sample = { at: new Date(at).toISOString(), sinceJoinMs: at - joinAt, guests: rows.map(cameraInbound) };
    samples.push(sample);
    await appendFile(file, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
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
