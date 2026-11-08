#!/usr/bin/env node
// Action latency per media plane, from real SDK clients in Chromium on one host.
//
//   pnpm prod:latency                                  # 20 cycles on each plane, chalk_sfu and cf_sfu interleaved
//   pnpm prod:latency --samples 3 --planes chalk_sfu
//   xvfb-run -a pnpm prod:latency --headed             # a visible browser instead of headless Chromium
//
// One cycle is one Episode in a new Space on that plane, with two guests: guest 1 acts and guest 2 watches.
// Metric ids and what each one times are in features/scorecard/schema.mjs.
// A cycle whose admission lands on the other plane, or that fails, is dropped and rerun; its reason is kept.
// Output in .private/prod-proof/<run>/: latency.json with every sample, and scorecard-<plane>.json in the
// public scorecard shape. With action.* budgets in perf/budgets.json, a p95 over budget, a timeout or a plane short
// of samples makes the exit code non-zero.
import { appendFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { ProofError, check, command, createRun, errorEvidence, loadConfig, publicFailure, save } from "./runtime.mjs";
import { cleanupRun, disposeResource, runLabel, sweepStaleRuns } from "./cleanup.mjs";
import { launchGuests } from "./media.mjs";
import { createSpace, episodeEnd, prepareIntegration } from "./proofs.mjs";
import { installLatencyProbe } from "./latency-probe.mjs";
import { budgetFailures, budgetWarnings, summarize } from "./latency-stats.mjs";
import { planeLimits, readBudgets } from "../../features/scorecard/budgets.mjs";
import { METRICS, SCORECARD_SCHEMA, WHOLE_CYCLE, parseScorecard } from "../../features/scorecard/schema.mjs";

const providers = { chalk_sfu: "chalk_sfu", cf_sfu: "cloudflare_sfu" };
const timeoutMs = 20_000;
const settleMs = 1500;
const disposeTimeoutMs = 15_000;
const clock = () => performance.timeOrigin + performance.now();

function options() {
  const { values } = parseArgs({
    options: {
      samples: { type: "string", default: "20" },
      planes: { type: "string", default: "chalk_sfu,cf_sfu" },
      headed: { type: "boolean", default: false },
      tier: { type: "string", default: "manual" },
      environment: { type: "string" },
      region: { type: "string", default: "unknown" },
      size: { type: "string", default: "unknown" },
    },
  });
  const samples = Number(values.samples);
  const planes = values.planes.split(",");
  check(Number.isInteger(samples) && samples > 0, "--samples must be a positive whole number", "configuration");
  for (const plane of planes) check(plane in providers, `Unknown media plane ${plane}`, "configuration");
  check(values.environment, "--environment must name where the API runs: ci, staging or production", "configuration");
  const { tier, environment, region, size, headed } = values;
  return { samples, planes, headed, scorecard: { tier, environment, region, size } };
}

// measure arms the receiver's watches, runs the action on the sender, and returns each watch's delay in ms.
async function measure(sender, receiver, action, value, specs) {
  const id = randomUUID();
  await receiver.evaluate((watch) => window.proofLatency.arm(watch.id, watch.specs, watch.timeoutMs), { id, specs, timeoutMs });
  const acted = await sender.evaluate((step) => window.proofLatency.act(step.action, step.value), { action, value });
  const seen = await receiver.evaluate((watch) => window.proofLatency.result(watch), id);
  return { acted, delays: Object.fromEntries(seen.map(({ name, at }) => [name, at === null ? null : Math.round(at - acted.at)])) };
}

function toggles(participantId) {
  const signal = (name, field, value) => ({ name, kind: "roster", participantId, field, value });
  return [
    { action: "camera", value: false, specs: [signal("action.camera_toggle.off_ms", "camera", "inactive"), { name: "action.unpublish.removed_ms", kind: "gone", participantId, source: "camera" }] },
    { action: "camera", value: true, specs: [signal("action.camera_toggle.on_ms", "camera", "active"), { name: "action.publish.first_frame_ms", kind: "frame", participantId, source: "camera" }] },
    { action: "microphone", value: false, specs: [signal("action.mic_toggle.off_ms", "microphone", "inactive"), { name: "action.unpublish.audio_removed_ms", kind: "gone", participantId, source: "microphone" }] },
    { action: "microphone", value: true, specs: [signal("action.mic_toggle.on_ms", "microphone", "active"), { name: "action.publish.first_audio_ms", kind: "frame", participantId, source: "microphone" }] },
  ];
}

async function shareSteps(origin, pages, participantId, sample) {
  const share = await pages[0].context().newPage();
  try {
    await share.goto(`${origin}/share`);
    await pages[0].bringToFront();
    const started = await measure(pages[0], pages[1], "screen", true, [
      { name: "action.screenshare.start_signal_ms", kind: "roster", participantId, field: "screenShare", value: "active" },
      { name: "action.screenshare.start_ms", kind: "frame", participantId, source: "screen" },
    ]);
    Object.assign(sample, started.delays);
    await sleep(settleMs);
    const stopped = await measure(pages[0], pages[1], "screen", false, [
      { name: "action.screenshare.stop_signal_ms", kind: "roster", participantId, field: "screenShare", value: "inactive" },
      { name: "action.screenshare.stop_ms", kind: "gone", participantId, source: "screen" },
    ]);
    Object.assign(sample, stopped.delays);
  } finally {
    await share.close();
  }
}

async function cycle(run, origin, plane, headed, ending) {
  const space = await createSpace(run, plane);
  const path = `${run.tenantPath}/spaces/${space.id}/episodes`;
  const createdAt = clock();
  const episode = await run.apiRequest("POST", path, { metadata: { proof_run_id: run.runId } });
  const createMs = clock() - createdAt;
  ending.path = `${path}/${episode.id}`;
  await appendFile(`${run.directory}/episodes.jsonl`, `${JSON.stringify(episode.id)}\n`, { mode: 0o600 });
  ending.current = episodeEnd(run, ending.path);
  const guests = await launchGuests(run, space, episode, null, origin, true, 2, { deferJoin: true, plane, headed, observeLeave: true });
  const landed = guests.admissions.map((admission) => admission.provider);
  check(
    landed.every((provider) => provider === providers[plane]),
    `Admitted on ${landed.join(",")}, not ${providers[plane]}`,
    "media-plane",
  );
  const { pages, participants } = guests;
  for (const page of pages) await page.evaluate(installLatencyProbe);
  const join = (guest) => ({ slug: space.slug, api: run.config.api_url, name: `Proof guest ${guest + 1}` });
  const first = await measure(pages[0], pages[0], "join", join(0), [{ name: "firstReady", kind: "ready" }]);
  const sample = { "action.spinup_ms": first.delays.firstReady === null ? null : Math.round(createMs + guests.admissions[0].ms + first.delays.firstReady) };
  const sender = participants[0];
  const second = await measure(pages[1], pages[1], "join", join(1), [
    { name: "action.join.first_audio_ms", kind: "frame", participantId: sender, source: "microphone" },
    { name: "action.join.first_video_ms", kind: "frame", participantId: sender, source: "camera" },
  ]);
  Object.assign(sample, second.delays);
  ending.current.useSDK(pages[1]); // Guest 1 leaves at the end, so guest 2 ends the Episode. Until both joined, the owner ends it.
  for (const step of toggles(sender)) {
    await sleep(settleMs);
    Object.assign(sample, (await measure(pages[0], pages[1], step.action, step.value, step.specs)).delays);
  }
  await sleep(settleMs);
  await shareSteps(origin, pages, sender, sample);
  await sleep(settleMs);
  const left = await measure(pages[0], pages[1], "leave", null, [
    { name: "action.leave_ms", kind: "left", participantId: sender },
    { name: "action.leave_media_removed_ms", kind: "silent", participantId: sender },
  ]);
  const ack = left.acted.leaveAckAt;
  Object.assign(sample, left.delays, { "action.leave_ack_ms": ack === null ? null : Math.round(ack - left.acted.at) });
  return { sample, browser: `chromium/${pages[0].context().browser()?.version()}`, parts: { createMs: Math.round(createMs), admitMs: Math.round(guests.admissions[0].ms), firstReadyMs: first.delays.firstReady } };
}

const reason = (error) => (error instanceof Error ? error.message : String(error));

// When the SDK cannot end the Episode, the owner API does, so a failed cycle never leaves a call open under the next one.
async function endEpisode(run, ending) {
  try {
    await ending.current.end();
  } catch (sdkError) {
    await episodeEnd(run, ending.path).end();
    throw sdkError;
  }
}

async function attempt(run, origin, plane, headed) {
  const mark = run.resources.length;
  const ending = { current: null };
  let outcome;
  try {
    outcome = { plane, ...(await cycle(run, origin, plane, headed, ending)) };
  } catch (error) {
    outcome = { plane, dropped: error instanceof ProofError && error.reason === "media-plane" ? "wrong_media_plane" : "cycle_failed", error: reason(error) };
  }
  if (ending.current) await endEpisode(run, ending).catch((error) => (outcome = { plane, dropped: "teardown_failed", error: `end Episode: ${reason(error)}` }));
  for (const resource of run.resources.slice(mark)) {
    const failures = await disposeResource(run, resource, disposeTimeoutMs);
    if (failures.length) outcome = { plane, dropped: "teardown_failed", error: `dispose: ${reason(failures[0])}` };
    run.resources.splice(run.resources.indexOf(resource), 1);
  }
  return outcome;
}

// Planes take turns, so a slow minute on the network or the host lands on both.
async function measureAll(run, origin, { samples, planes, headed }, report) {
  const kept = Object.fromEntries(planes.map((plane) => [plane, 0]));
  const tries = Object.fromEntries(planes.map((plane) => [plane, 0]));
  const limit = samples + 10;
  for (let turn = 0; ; turn++) {
    const open = planes.filter((plane) => kept[plane] < samples && tries[plane] < limit);
    if (!open.length) return;
    const plane = open[turn % open.length];
    tries[plane]++;
    const outcome = await attempt(run, origin, plane, headed);
    report.cycles.push(outcome);
    if (!outcome.dropped) kept[plane]++;
    console.log(`${plane} cycle ${tries[plane]}: ${outcome.dropped ? `dropped (${outcome.dropped}): ${outcome.error}` : "kept"}`);
  }
}

async function conclude(report, { samples, planes }) {
  const { budgets } = await readBudgets();
  report.planes = {};
  for (const plane of planes) {
    const kept = report.cycles.filter((outcome) => outcome.plane === plane && !outcome.dropped);
    const summary = summarize(kept.map((outcome) => outcome.sample));
    const limits = planeLimits(budgets, plane);
    const failures = budgetFailures(summary, limits, samples);
    const warnings = budgetWarnings(summary, limits);
    if (kept.length < samples) failures.unshift(`${kept.length} of ${samples} cycles kept`);
    report.planes[plane] = { kept: kept.length, dropped: report.cycles.filter((outcome) => outcome.plane === plane && outcome.dropped).length, summary, failures, warnings };
  }
}

// scorecard is the public view of one plane: percentiles per metric id, and what was dropped and why.
function scorecard(report, plane, run) {
  const { summary } = report.planes[plane];
  const drops = new Map();
  for (const outcome of report.cycles.filter((cycle) => cycle.plane === plane && cycle.dropped)) {
    drops.set(`${WHOLE_CYCLE} ${outcome.dropped}`, (drops.get(`${WHOLE_CYCLE} ${outcome.dropped}`) ?? 0) + 1);
  }
  for (const [metric, { timeouts }] of Object.entries(summary)) if (timeouts) drops.set(`${metric} timeout`, timeouts);
  return parseScorecard({
    schema: SCORECARD_SCHEMA,
    run,
    mediaPlane: plane,
    metrics: Object.keys(METRICS)
      .filter((id) => summary[id])
      .map((id) => ({ id, unit: METRICS[id].unit, n: summary[id].n, p50: summary[id].p50, p95: summary[id].p95, source: "latency-kit" })),
    dropped: [...drops].map(([key, count]) => {
      const [metric, reason] = key.split(" ");
      return { metric, reason, count };
    }),
  });
}

function table(report) {
  const planes = Object.keys(report.planes);
  const metrics = [...new Set(planes.flatMap((plane) => Object.keys(report.planes[plane].summary)))];
  const cell = (plane, metric) => {
    const value = report.planes[plane].summary[metric];
    return value ? `${value.p50} / ${value.p95} (n=${value.n}${value.timeouts ? `, ${value.timeouts} timed out` : ""})` : "-";
  };
  return [`| metric | ${planes.map((plane) => `${plane} p50 / p95 ms`).join(" | ")} |`, `| --- | ${planes.map(() => "---").join(" | ")} |`, ...metrics.map((metric) => `| ${metric} | ${planes.map((plane) => cell(plane, metric)).join(" | ")} |`)].join("\n");
}

async function main() {
  const settings = options();
  const runId = process.env.CHALK_PROOF_RUN_ID ?? `${Date.now()}-${randomUUID()}`;
  runLabel(runId);
  const directory = resolve(".private", "prod-proof", runId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report = { startedAt: new Date().toISOString(), settings, cycles: [] };
  let run;
  try {
    const config = await loadConfig({ readiness: false });
    await sweepStaleRuns(config);
    run = await createRun(config, directory, undefined, runId);
    const receiver = await prepareIntegration(run, false);
    await measureAll(run, receiver.origin, settings, report);
  } catch (error) {
    report.error = errorEvidence(error);
    publicFailure("latency", error);
  } finally {
    if (run) await cleanupRun(run).catch((error) => (report.cleanupError = errorEvidence(error)));
  }
  await conclude(report, settings);
  report.result = !report.error && !report.cleanupError && Object.values(report.planes).every((plane) => !plane.failures.length) ? "passed" : "failed";
  await save(`${directory}/latency.json`, report);
  const browser = (report.cycles.find((cycle) => cycle.browser)?.browser ?? "unknown").replace(/^chromium/, settings.headed ? "chromium-headed" : "chromium-headless");
  const commit = (await command("git", ["rev-parse", "HEAD"])).trim();
  const client = { kind: "browser", browser, region: settings.scorecard.region, size: settings.scorecard.size };
  const identity = { id: runId, commit, tier: settings.scorecard.tier, environment: settings.scorecard.environment, startedAt: report.startedAt, client };
  for (const plane of settings.planes) await save(`${directory}/scorecard-${plane}.json`, scorecard(report, plane, identity));
  console.log(table(report));
  for (const [plane, { failures, warnings }] of Object.entries(report.planes)) {
    for (const failure of failures) console.log(`${plane}: ${failure}`);
    for (const warning of warnings) console.log(`${plane}: warning, ${warning}`);
  }
  console.log(`Private evidence: ${directory}`);
  if (report.result !== "passed") process.exitCode = 1;
}

await main();
