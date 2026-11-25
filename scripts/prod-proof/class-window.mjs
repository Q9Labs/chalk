#!/usr/bin/env node
// Concurrent classes on the Chalk SFU. Each class is one Space, one Episode and three headless SDK guests with cameras,
// and one guest shares its screen in stretches. Shards start their classes at one shared window, so several machines
// can hold one load. `plan` is arithmetic (class-window-plan.mjs); `run` judges each class from its samples (class-window-judge.mjs).
//
//   node scripts/prod-proof/class-window.mjs plan --classes 20 --node-size s-2vcpu-2gb --hours 3
//
//   CHALK_PROOF_CONFIG_SOURCE=env CHALK_PROOF_API_KEY=... CHALK_PROOF_TENANT_ID=... CHALK_PROOF_API_URL=... \
//     CHALK_PROOF_WEB_URL=... CHALK_PROOF_PROOF_ORIGIN=... CHALK_PROOF_WEBHOOK_SERVICE_URL=... CHALK_PROOF_WEBHOOK_ENDPOINT_ID=... \
//     node scripts/prod-proof/class-window.mjs run --environment staging --confirm staging --expect-api-host <host> \
//       --window-start 2026-11-26T20:00:00Z --first-class 0 --classes 5 --hold-minutes 20
//
// `run` never reads the 1Password default, which is the production proof Tenant. It needs a stack the operator stood up
// for this run, and it refuses unless the API host it talks to is the one named by --expect-api-host. It writes
// samples.jsonl and verdict.json per class under --out (default .private/class-window/<window>) and exits 1 unless every
// class passes. The output holds run identifiers, so keep it out of Git.
import { mkdir, appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { planClassWindow } from "./class-window-plan.mjs";
import { judgeClass, judgeRun } from "./class-window-judge.mjs";

// Sampling every 10 s matches the SFU soak. The ramp keeps joins out of the verdict, and the share startup allowance
// keeps a stretch's first frame from failing it.
const sampleMs = 10_000;
const rampMs = 120_000;
const shareStartupMs = 30_000;
const prepareMs = 90_000;
const sharePeriodMs = 4 * 60_000;
const liveTimeoutMs = 120_000;

const usage = [
  "usage: class-window.mjs plan [--classes N] [--participants N] [--node-size S] [--hours H] [--shards N] [--share-duty F]",
  "       class-window.mjs run --environment <nightly|staging> --confirm <same> --expect-api-host <host> --window-start <ISO>",
  "                            --first-class N --classes N [--participants N] [--share-duty F] [--hold-minutes N]",
  "                            [--overrun-class N --overrun-minutes N] [--out DIR]",
].join("\n");

const fail = (message) => {
  console.error(`class-window: ${message}`);
  console.error(usage);
  process.exit(2);
};

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    classes: { type: "string" },
    participants: { type: "string", default: "3" },
    "node-size": { type: "string", default: "s-2vcpu-2gb" },
    hours: { type: "string", default: "3" },
    shards: { type: "string", default: "1" },
    "share-duty": { type: "string", default: "0.65" },
    environment: { type: "string" },
    confirm: { type: "string" },
    "expect-api-host": { type: "string" },
    "window-start": { type: "string" },
    "first-class": { type: "string", default: "0" },
    "hold-minutes": { type: "string", default: "10" },
    "overrun-class": { type: "string" },
    "overrun-minutes": { type: "string", default: "4" },
    out: { type: "string" },
  },
});

const whole = (raw, name) => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) fail(`${name} must be a whole number`);
  return value;
};

const command = positionals[0];
if (command === "plan") {
  const plan = planClassWindow({
    classes: whole(values.classes ?? "20", "--classes"),
    participants: whole(values.participants, "--participants"),
    nodeSize: values["node-size"],
    hours: Number(values.hours),
    shards: whole(values.shards, "--shards"),
    shareDuty: Number(values["share-duty"]),
  });
  console.log(JSON.stringify(plan, null, 2));
} else if (command === "run") {
  await runWindow();
} else {
  fail("expected a plan or run command");
}

function requireDisposableTarget() {
  const environment = values.environment;
  if (!["nightly", "staging"].includes(environment)) fail("--environment must be nightly or staging");
  if (values.confirm !== environment) fail("--confirm must repeat --environment");
  if (!values["expect-api-host"]) fail("--expect-api-host names the run's own API host");
  if (process.env.CHALK_PROOF_CONFIG_SOURCE !== "env") fail("set CHALK_PROOF_CONFIG_SOURCE=env; the 1Password default is the production proof Tenant");
  if (!process.env.CHALK_PROOF_API_URL) fail("set CHALK_PROOF_API_URL to the disposable stack");
  const configuredOrigin = new URL(process.env.CHALK_PROOF_API_URL);
  if (configuredOrigin.hostname === "api.chalkmeet.com") fail("this proof does not run against the production API");
  if (configuredOrigin.host !== values["expect-api-host"]) fail("the configured API host is not --expect-api-host");
}

function windowOptions() {
  const windowIso = values["window-start"];
  const windowStart = Date.parse(windowIso);
  if (Number.isNaN(windowStart)) fail("--window-start must be an ISO time");
  const lead = windowStart - Date.now();
  if (lead < 3 * 60_000 || lead > 25 * 60_000) fail("the shared start must be 3 to 25 minutes away");
  const classes = whole(values.classes ?? "0", "--classes");
  if (classes < 1) fail("--classes must be at least 1");
  const firstClass = whole(values["first-class"], "--first-class");
  const holdMs = whole(values["hold-minutes"], "--hold-minutes") * 60_000;
  if (holdMs <= rampMs + shareStartupMs) fail("--hold-minutes must leave time to sample media after the ramp");
  const overrunClass = values["overrun-class"] === undefined ? -1 : whole(values["overrun-class"], "--overrun-class");
  const overrunMs = overrunClass < 0 ? 0 : whole(values["overrun-minutes"], "--overrun-minutes") * 60_000;
  if (lead + holdMs + overrunMs > 50 * 60_000) fail("finish within the proof key's lifetime (at most 50 minutes from now)");
  const participants = whole(values.participants, "--participants");
  const shareDuty = Number(values["share-duty"]);
  if (!(shareDuty >= 0 && shareDuty <= 1)) fail("--share-duty must be between 0 and 1");
  const out = resolve(values.out ?? `.private/class-window/${windowIso.replace(/[:.]/g, "-")}`);
  return { windowIso, windowStart, classes, firstClass, holdMs, overrunClass, overrunMs, participants, shareDuty, out };
}

async function runWindow() {
  requireDisposableTarget();
  const { windowIso, windowStart, classes, firstClass, holdMs, overrunClass, overrunMs, participants, shareDuty, out } = windowOptions();

  const { loadConfig, createRun, errorEvidence, save, publicFailure, waitFor } = await import("./runtime.mjs");
  const { cleanupRun } = await import("./cleanup.mjs");
  const { prepareIntegration, createProofKey, createSpace, openEpisodeInSpace, episodeEnd } = await import("./proofs.mjs");
  const { launchGuests, stats } = await import("./media.mjs");
  const { manualPolicy } = await import("./space-fixture.mjs");

  await mkdir(out, { recursive: true, mode: 0o700 });
  const config = await loadConfig({ capabilities: false });

  const controller = new AbortController();
  const signal = controller.signal;
  const shardRunId = `cw-${windowIso.replace(/\D/g, "").slice(0, 14)}-${firstClass}-${randomUUID().slice(0, 8)}`;
  const shardRun = await createRun(config, resolve(out, "shard"), signal, shardRunId);
  const stop = () => controller.abort(new Error("Class window interrupted"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let origin;
  let cleanupFailed = false;
  const verdicts = [];
  try {
    origin = (await prepareIntegration(shardRun, false)).origin;
    const settled = await Promise.allSettled(Array.from({ length: classes }, (_, offset) => runClass(firstClass + offset)));
    settled.forEach((result, offset) => {
      verdicts.push(result.status === "fulfilled" ? result.value : { class: firstClass + offset, pass: false, reason: "class-crashed" });
    });
  } finally {
    await cleanupRun(shardRun).catch((error) => {
      cleanupFailed = true;
      publicFailure("shard cleanup", error);
    });
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  const verdict = judgeRun(verdicts);
  if (cleanupFailed || signal.aborted) verdict.pass = false;
  if (cleanupFailed) verdict.cleanupFailed = true;
  await save(resolve(out, "verdict.json"), { window: windowIso, firstClass, classes, participants, shareDuty, verdicts, ...verdict });
  console.log(`class-window: ${verdict.passed}/${verdict.classes} classes passed${verdict.failed.length ? `; failed ${verdict.failed.join(",")}` : ""}`);
  if (!verdict.pass) process.exitCode = 1;

  async function runClass(index) {
    const directory = resolve(out, `class-${index}`);
    const run = await createRun(config, directory, signal, `${shardRunId}-k${index}`);
    const scheduledEnd = windowStart + holdMs;
    const classEnd = scheduledEnd + (index === overrunClass ? overrunMs : 0);
    let booking;
    let result;
    try {
      await createProofKey(run);
      const episodeDurationSeconds = Math.ceil((classEnd - windowStart + prepareMs) / 1000) + 60;
      const space = await createSpace(run, manualPolicy, { reuse: false, episodeDurationSeconds });
      booking = `${run.tenantPath}/spaces/${space.id}/scheduled-episodes/${randomUUID()}`;
      await run.apiRequest("PUT", booking, {
        starts_at: new Date(windowStart).toISOString(),
        expected_ends_at: new Date(scheduledEnd).toISOString(),
        expected_participants: Array.from({ length: participants }, (_, guest) => ({ name: `Guest ${guest + 1}` })),
      });
      if (Date.now() >= windowStart - prepareMs) throw new Error("booking completed too late to prove prewarm");
      await save(resolve(directory, "booking.json"), { bookedAt: new Date().toISOString(), scheduledEnd: new Date(scheduledEnd).toISOString() });
      await until(windowStart - prepareMs, signal);
      const openingStarted = performance.now();
      const { episode } = await openEpisodeInSpace(run, space);
      const openEpisodeMs = Math.round(performance.now() - openingStarted);
      const ending = episodeEnd(run, `${run.tenantPath}/spaces/${space.id}/episodes/${episode.id}`);
      const guests = await launchGuests(run, space, episode, null, origin, true, participants, { deferJoin: true });
      await until(windowStart, signal);
      const joiningStarted = performance.now();
      await Promise.all(guests.pages.map((page, guest) => page.evaluate(({ slug, api, name }) => window.proofJoin(slug, api, name), { slug: space.slug, api: config.api_url, name: `Class ${index} guest ${guest + 1}` })));
      await waitFor(`class ${index} live`, () => allLive(guests.pages, participants), liveTimeoutMs, 2000, signal);
      const mediaLiveMs = Math.round(performance.now() - joiningStarted);
      const samples = await hold(guests.pages, resolve(directory, "samples.jsonl"), classEnd);
      ending.useSDK(guests.pages[0]);
      await ending.end();
      result = { class: index, openEpisodeMs, mediaLiveMs, ...judgeClass({ samples, participants, rampMs, shareStartupMs }) };
    } catch (error) {
      publicFailure(`class ${index}`, error);
      await save(resolve(directory, "error.json"), errorEvidence(error)).catch(() => {});
      result = { class: index, pass: false, reason: "class-failed" };
    } finally {
      if (booking) await run.apiRequest("DELETE", booking, undefined, AbortSignal.timeout(30_000)).catch((error) => cleanupFailure("cancel", error));
      await cleanupRun(run).catch((error) => cleanupFailure("cleanup", error));
    }
    await save(resolve(directory, "verdict.json"), result);
    return result;

    function cleanupFailure(action, error) {
      publicFailure(`class ${index} ${action}`, error);
      result.pass = false;
      result.cleanupFailed = true;
    }
  }

  // Sample every guest's inbound video once per interval, and share the sharer's screen in stretches after the ramp.
  // Each sample is appended as it is taken, so a crash keeps the evidence so far.
  async function hold(pages, file, end) {
    const samples = [];
    let shareOn = false;
    let shareStartedAt = null;
    const firstSample = windowStart + Math.ceil((Date.now() - windowStart) / sampleMs) * sampleMs;
    for (let at = Math.min(firstSample, end); at <= end; at += sampleMs) {
      await until(at, signal);
      const offset = at - windowStart;
      const wanted = at === end ? shareOn : offset >= rampMs && (offset - rampMs) % sharePeriodMs < shareDuty * sharePeriodMs;
      if (wanted !== shareOn) {
        await pages[0].evaluate((enabled) => window.proofClient.media.setScreenShareEnabled(enabled), wanted);
        shareOn = wanted;
        shareStartedAt = wanted ? offset : null;
      }
      const rows = await stats(pages);
      const sample = { at: offset, shareOn, shareStartedAt, guests: rows.map(videoInbound) };
      samples.push(sample);
      await appendFile(file, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
    }
    return samples;
  }
}

function videoInbound(rows) {
  return rows.filter((row) => row.type === "inbound-rtp" && row.kind === "video").map(({ type, kind, source, id, connection, framesDecoded, bytesReceived }) => ({ type, kind, source, id, connection, framesDecoded, bytesReceived }));
}

async function until(atMs, signal) {
  const { setTimeout: delay } = await import("node:timers/promises");
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
