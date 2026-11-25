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
//       --window-start 2026-11-26T20:00:00Z --first-class 0 --classes 5 --hold-minutes 60
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
  "                            --first-class N --classes N [--participants N] [--share-duty F] [--hold-minutes N] [--out DIR]",
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
    "hold-minutes": { type: "string", default: "60" },
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

async function runWindow() {
  const environment = values.environment;
  if (!["nightly", "staging"].includes(environment)) fail("--environment must be nightly or staging");
  if (values.confirm !== environment) fail("--confirm must repeat --environment");
  if (!values["expect-api-host"]) fail("--expect-api-host names the run's own API host");
  if (process.env.CHALK_PROOF_CONFIG_SOURCE !== "env") fail("set CHALK_PROOF_CONFIG_SOURCE=env; the 1Password default is the production proof Tenant");
  if (!values["window-start"] || Number.isNaN(Date.parse(values["window-start"]))) fail("--window-start must be an ISO time");
  const windowIso = values["window-start"];
  const windowStart = Date.parse(windowIso);
  const classes = whole(values.classes ?? "0", "--classes");
  if (classes < 1) fail("--classes must be at least 1");
  const firstClass = whole(values["first-class"], "--first-class");
  const holdMs = whole(values["hold-minutes"], "--hold-minutes") * 60_000;
  const participants = whole(values.participants, "--participants");
  const shareDuty = Number(values["share-duty"]);
  if (!(shareDuty >= 0 && shareDuty <= 1)) fail("--share-duty must be between 0 and 1");
  const out = resolve(values.out ?? `.private/class-window/${windowIso.replace(/[:.]/g, "-")}`);

  const { loadConfig, createRun, errorEvidence, save, publicFailure, waitFor } = await import("./runtime.mjs");
  const { cleanupRun, sweepStaleRuns } = await import("./cleanup.mjs");
  const { prepareIntegration, createSpace, openEpisodeInSpace, episodeEnd } = await import("./proofs.mjs");
  const { launchGuests, stats } = await import("./media.mjs");
  const { manualPolicy } = await import("./space-fixture.mjs");

  await mkdir(out, { recursive: true, mode: 0o700 });
  const config = await loadConfig({ capabilities: false });
  if (new URL(config.api_url).host !== values["expect-api-host"]) fail("the configured API host is not --expect-api-host");

  const controller = new AbortController();
  const signal = controller.signal;
  const shardRunId = `cw-${windowIso.replace(/\D/g, "").slice(0, 14)}-${firstClass}-${randomUUID().slice(0, 8)}`;
  const shardRun = await createRun(config, resolve(out, "shard"), signal, shardRunId);
  let origin;
  const verdicts = [];
  try {
    await sweepStaleRuns(config);
    origin = (await prepareIntegration(shardRun, false)).origin;
    const settled = await Promise.allSettled(Array.from({ length: classes }, (_, offset) => runClass(firstClass + offset)));
    settled.forEach((result, offset) => {
      verdicts.push(result.status === "fulfilled" ? result.value : { class: firstClass + offset, pass: false, reason: "class-crashed" });
    });
  } finally {
    await cleanupRun(shardRun).catch((error) => publicFailure("shard cleanup", error));
  }
  const verdict = judgeRun(verdicts);
  await save(resolve(out, "verdict.json"), { window: windowIso, firstClass, classes, participants, shareDuty, verdicts, ...verdict });
  console.log(`class-window: ${verdict.passed}/${verdict.classes} classes passed${verdict.failed.length ? `; failed ${verdict.failed.join(",")}` : ""}`);
  if (!verdict.pass) process.exitCode = 1;

  async function runClass(index) {
    const directory = resolve(out, `class-${index}`);
    const run = await createRun(config, directory, signal, `${shardRunId}-k${index}`);
    try {
      await until(windowStart - prepareMs, signal);
      const space = await createSpace(run, manualPolicy);
      const { episode } = await openEpisodeInSpace(run, space);
      const ending = episodeEnd(run, `${run.tenantPath}/spaces/${space.id}/episodes/${episode.id}`);
      const guests = await launchGuests(run, space, episode, null, origin, false, participants, { deferJoin: true });
      await until(windowStart, signal);
      await Promise.all(
        guests.pages.map((page, guest) =>
          page.evaluate(({ slug, api, name }) => window.proofJoin(slug, api, name), { slug: space.slug, api: config.api_url, name: `Class ${index} guest ${guest + 1}` }),
        ),
      );
      await waitFor(`class ${index} live`, () => allLive(guests.pages, participants), liveTimeoutMs, 2000, signal);
      const samples = await hold(guests.pages, resolve(directory, "samples.jsonl"));
      ending.useSDK(guests.pages[0]);
      await ending.end();
      const result = { class: index, ...judgeClass({ samples, participants, rampMs, shareStartupMs }) };
      await save(resolve(directory, "verdict.json"), result);
      return result;
    } catch (error) {
      publicFailure(`class ${index}`, error);
      await save(resolve(directory, "error.json"), errorEvidence(error)).catch(() => {});
      return { class: index, pass: false, reason: "class-failed" };
    } finally {
      await cleanupRun(run).catch((error) => publicFailure(`class ${index} cleanup`, error));
    }
  }

  // Sample every guest's inbound video once per interval, and share the sharer's screen in stretches after the ramp.
  // Each sample is appended as it is taken, so a crash keeps the evidence so far.
  async function hold(pages, file) {
    const samples = [];
    let shareOn = false;
    let shareStartedAt = null;
    for (let at = windowStart; at < windowStart + holdMs; at += sampleMs) {
      await until(at, signal);
      const offset = at - windowStart;
      const wanted = offset >= rampMs && (offset - rampMs) % sharePeriodMs < shareDuty * sharePeriodMs;
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
  return rows
    .filter((row) => row.type === "inbound-rtp" && row.kind === "video")
    .map(({ type, kind, source, id, connection, framesDecoded, bytesReceived }) => ({ type, kind, source, id, connection, framesDecoded, bytesReceived }));
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
