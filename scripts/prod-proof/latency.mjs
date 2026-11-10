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
import { diagnosticsFile, scorecard } from "./latency-card.mjs";
import { audioPath, diagnosticsOf, joinStages, syncRoundTrip, toggleStages } from "./latency-stages.mjs";
import { icePairOf } from "./latency-ice.mjs";
import { budgetFailures, budgetWarnings, summarize } from "./latency-stats.mjs";
import { diagnosticsFileName, diagnosticsMarkdown } from "../../features/scorecard/diagnostics.mjs";
import { planeLimits, readBudgets } from "../../features/scorecard/budgets.mjs";

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
      "lobby-dwell-ms": { type: "string", default: "0" },
    },
  });
  const samples = Number(values.samples);
  const planes = values.planes.split(",");
  check(Number.isInteger(samples) && samples > 0 && samples <= 60, "--samples must be a whole number from 1 to 60", "configuration");
  for (const plane of planes) check(plane in providers, `Unknown media plane ${plane}`, "configuration");
  check(values.environment, "--environment must name where the API runs: ci, staging or production", "configuration");
  const lobbyDwellMs = Number(values["lobby-dwell-ms"]);
  check(Number.isInteger(lobbyDwellMs) && lobbyDwellMs >= 0 && lobbyDwellMs <= 15000, "--lobby-dwell-ms must be a whole number from 0 to 15000 (preconnect keeps a socket ready for 16 s after its last call)", "configuration");
  const { tier, environment, region, size, headed } = values;
  return { samples, planes, headed, lobbyDwellMs, scorecard: { tier, environment, region, size } };
}

// measure arms the receiver's watches, runs the action on the sender, and returns each watch's delay in ms.
async function measure(sender, receiver, action, value, specs) {
  const id = randomUUID();
  await receiver.evaluate((watch) => window.proofLatency.arm(watch.id, watch.specs, watch.timeoutMs), { id, specs, timeoutMs });
  const acted = await sender.evaluate((step) => window.proofLatency.act(step.action, step.value), { action, value });
  const seen = await receiver.evaluate((watch) => window.proofLatency.result(watch), id);
  return { acted, delays: Object.fromEntries(seen.map(({ name, at }) => [name, at === null ? null : Math.round(at - acted.at)])), ats: Object.fromEntries(seen.map(({ name, at }) => [name, at])) };
}

// observe reads the wire trace. The trace explains the action metrics and never gates them, so a failed read
// leaves its numbers null and says so, and the cycle still counts.
async function observe(what, read, fallback) {
  try {
    return await read();
  } catch (error) {
    console.warn(`trace: ${what} skipped: ${reason(error)}`);
    return fallback;
  }
}

const takeTrace = (page, from) => page.evaluate((since) => window.proofTrace.take(since), from);

// toggleTrace splits a finished toggle. The first spec is the receiver's roster change and the second its media change.
async function toggleTrace(pages, step, result) {
  const [roster, media] = step.specs;
  const t0 = result.acted.at;
  return observe(step.group, async () => toggleStages(step.group, { t0, sender: await takeTrace(pages[0], t0), receiver: await takeTrace(pages[1], t0), command: step.command, visibleAt: result.ats[roster.name], finalAt: result.ats[media.name] }), {});
}

function toggles(participantId) {
  const signal = (name, field, value) => ({ name, kind: "roster", participantId, field, value });
  return [
    { action: "camera", value: false, group: "camera_off", command: "live_target:set_camera_enabled:false", specs: [signal("action.camera_toggle.off_ms", "camera", "inactive"), { name: "action.unpublish.removed_ms", kind: "gone", participantId, source: "camera" }] },
    { action: "camera", value: true, group: "camera_on", command: "live_target:set_camera_enabled:true", specs: [signal("action.camera_toggle.on_ms", "camera", "active"), { name: "action.publish.first_frame_ms", kind: "frame", participantId, source: "camera" }] },
    { action: "microphone", value: false, group: "mic_off", command: "live_target:set_microphone_enabled:false", specs: [signal("action.mic_toggle.off_ms", "microphone", "inactive"), { name: "action.unpublish.audio_removed_ms", kind: "gone", participantId, source: "microphone" }] },
    { action: "microphone", value: true, group: "mic_on", command: "live_target:set_microphone_enabled:true", specs: [signal("action.mic_toggle.on_ms", "microphone", "active"), { name: "action.publish.first_audio_ms", kind: "frame", participantId, source: "microphone" }] },
  ];
}

async function shareSteps(origin, pages, participantId, sample, stages) {
  const share = await pages[0].context().newPage();
  try {
    await share.goto(`${origin}/share`);
    await pages[0].bringToFront();
    const start = {
      group: "screen_start",
      command: "live_target:set_screen_share_enabled:true",
      specs: [
        { name: "action.screenshare.start_signal_ms", kind: "roster", participantId, field: "screenShare", value: "active" },
        { name: "action.screenshare.start_ms", kind: "frame", participantId, source: "screen" },
      ],
    };
    const started = await measure(pages[0], pages[1], "screen", true, start.specs);
    Object.assign(sample, started.delays);
    Object.assign(stages, await toggleTrace(pages, start, started));
    await sleep(settleMs);
    const stop = {
      group: "screen_stop",
      command: "live_target:set_screen_share_enabled:false",
      specs: [
        { name: "action.screenshare.stop_signal_ms", kind: "roster", participantId, field: "screenShare", value: "inactive" },
        { name: "action.screenshare.stop_ms", kind: "gone", participantId, source: "screen" },
      ],
    };
    const stopped = await measure(pages[0], pages[1], "screen", false, stop.specs);
    Object.assign(sample, stopped.delays);
    Object.assign(stages, await toggleTrace(pages, stop, stopped));
  } finally {
    await share.close();
  }
}

async function cycle(run, origin, plane, headed, lobbyDwellMs, ending) {
  const space = await createSpace(run, plane);
  const path = `${run.tenantPath}/spaces/${space.id}/episodes`;
  const createdAt = clock();
  const episode = await run.apiRequest("POST", path, { metadata: { proof_run_id: run.runId } });
  const createMs = clock() - createdAt;
  ending.path = `${path}/${episode.id}`;
  await appendFile(`${run.directory}/episodes.jsonl`, `${JSON.stringify(episode.id)}\n`, { mode: 0o600 });
  ending.current = episodeEnd(run, ending.path);
  const guests = await launchGuests(run, space, episode, null, origin, true, 2, { deferJoin: true, plane, headed, observeLeave: true, trace: true, lobby: lobbyDwellMs > 0 });
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
  // A person reaches the call from a lobby. The second guest models that when asked: its page starts the Sync upgrade, waits, and
  // only then joins, so the join timer starts after the dwell. Without the flag the join starts cold, as before.
  const lobbyStartedAt = clock();
  if (lobbyDwellMs > 0) await pages[1].evaluate(({ api, dwell }) => window.proofLobby(api, dwell), { api: run.config.api_url, dwell: lobbyDwellMs });
  const second = await measure(pages[1], pages[1], "join", join(1), [
    { name: "action.join.first_audio_ms", kind: "frame", participantId: sender, source: "microphone" },
    { name: "action.join.first_video_ms", kind: "frame", participantId: sender, source: "camera" },
  ]);
  Object.assign(sample, second.delays);
  // The pair is read now, after the join's measured stages and before the next measured action, never inside either.
  await observe("ice pair", () => pages[1].evaluate(() => window.proofTrace.readIce()), undefined);
  const joined = await observe(
    "join",
    async () => {
      const events = await takeTrace(pages[1], lobbyStartedAt);
      return { stages: joinStages({ t0: second.acted.at, events }), ice: icePairOf(events, second.acted.at) };
    },
    { stages: {}, ice: null },
  );
  const stages = joined.stages;
  ending.current.useSDK(pages[1]); // Guest 1 leaves at the end, so guest 2 ends the Episode. Until both joined, the owner ends it.
  for (const step of toggles(sender)) {
    await sleep(settleMs);
    const result = await measure(pages[0], pages[1], step.action, step.value, step.specs);
    Object.assign(sample, result.delays);
    Object.assign(stages, await toggleTrace(pages, step, result));
  }
  await sleep(settleMs);
  await shareSteps(origin, pages, sender, sample, stages);
  // The call is steady for the settle pause after the actions: the listener's audio counters are read on both sides of it.
  const audioBefore = await observe("audio counters", () => pages[1].evaluate(() => window.proofTrace.audioStats()), null);
  await sleep(settleMs);
  const audioAfter = await observe("audio counters", () => pages[1].evaluate(() => window.proofTrace.audioStats()), null);
  // The SFU round trip is read while the call is steady, after the actions and before leave. The Sync round trip is the SDK's own
  // pings and the pongs that answer them, read from the trace afterwards: the kit sends nothing on the Sync socket.
  const rtt = await observe("round trip", async () => ({ sfu_ms: await pages[0].evaluate(() => window.proofTrace.sfuRtt()), sync_ms: syncRoundTrip(await takeTrace(pages[0], 0)) }), { sfu_ms: null, sync_ms: null });
  const listenerRtt = await observe("listener round trip", () => pages[1].evaluate(() => window.proofTrace.sfuRtt()), null);
  // The estimate goes to the sidecar only, never into `sample`, so the card is the card it always was. One that could not be made is left out.
  const audio = audioBefore && audioAfter ? audioPath(audioBefore, audioAfter, { sender: rtt.sfu_ms, receiver: listenerRtt }) : undefined;
  const left = await measure(pages[0], pages[1], "leave", null, [
    { name: "action.leave_ms", kind: "left", participantId: sender },
    { name: "action.leave_media_removed_ms", kind: "silent", participantId: sender },
  ]);
  const ack = left.acted.leaveAckAt;
  Object.assign(sample, left.delays, { "action.leave_ack_ms": ack === null ? null : Math.round(ack - left.acted.at) });
  return {
    sample,
    trace: { rtt, stages, ...(audio ? { audio } : {}), ...(joined.ice ? { ice: joined.ice } : {}) },
    browser: `chromium/${pages[0].context().browser()?.version()}`,
    parts: { createMs: Math.round(createMs), admitMs: Math.round(guests.admissions[0].ms), firstReadyMs: first.delays.firstReady },
  };
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

async function attempt(run, origin, plane, headed, lobbyDwellMs) {
  const mark = run.resources.length;
  const ending = { current: null };
  const timestamp = new Date().toISOString();
  let outcome;
  try {
    outcome = { plane, timestamp, ...(await cycle(run, origin, plane, headed, lobbyDwellMs, ending)) };
  } catch (error) {
    // A Space that cannot be on the requested plane is a setup error: every later cycle would fail the same way.
    if (error instanceof ProofError && error.reason === "media-plane-config") throw error;
    outcome = { plane, timestamp, dropped: error instanceof ProofError && error.reason === "media-plane" ? "wrong_media_plane" : "cycle_failed", error: reason(error) };
  }
  if (ending.current) await endEpisode(run, ending).catch((error) => (outcome = { plane, timestamp, dropped: "teardown_failed", error: `end Episode: ${reason(error)}` }));
  for (const resource of run.resources.slice(mark)) {
    const failures = await disposeResource(run, resource, disposeTimeoutMs);
    if (failures.length) outcome = { plane, timestamp, dropped: "teardown_failed", error: `dispose: ${reason(failures[0])}` };
    run.resources.splice(run.resources.indexOf(resource), 1);
  }
  return outcome;
}

// Planes take turns, so a slow minute on the network or the host lands on both.
async function measureAll(run, origin, { samples, planes, headed, lobbyDwellMs }, report) {
  const kept = Object.fromEntries(planes.map((plane) => [plane, 0]));
  const tries = Object.fromEntries(planes.map((plane) => [plane, 0]));
  const limit = samples + 10;
  for (let turn = 0; ; turn++) {
    const open = planes.filter((plane) => kept[plane] < samples && tries[plane] < limit);
    if (!open.length) return;
    const plane = open[turn % open.length];
    tries[plane]++;
    const outcome = await attempt(run, origin, plane, headed, lobbyDwellMs);
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
  for (const plane of settings.planes) {
    await save(`${directory}/scorecard-${plane}.json`, scorecard(report, plane, identity));
    const diagnostics = diagnosticsFile(report, plane);
    if (diagnostics) await save(`${directory}/${diagnosticsFileName(plane)}`, diagnostics);
  }
  console.log(table(report));
  for (const plane of settings.planes) {
    const summary = diagnosticsOf(report.cycles.filter((cycle) => cycle.plane === plane && !cycle.dropped));
    if (summary) console.log(`\n${plane}\n${diagnosticsMarkdown(summary)}`);
  }
  for (const [plane, { failures, warnings }] of Object.entries(report.planes)) {
    for (const failure of failures) console.log(`${plane}: ${failure}`);
    for (const warning of warnings) console.log(`${plane}: warning, ${warning}`);
  }
  console.log(`Private evidence: ${directory}`);
  if (report.result !== "passed") process.exitCode = 1;
}

await main();
