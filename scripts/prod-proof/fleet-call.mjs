// One scripted call of the canary fleet: real SDK clients in headless Chromium with generated media join one
// Episode, toggle microphone and camera, share a screen, leave and rejoin, ride out fault pulses, and end it.
// Every check appends to `call.findings`; a call never throws for a media failure, only for a setup failure.
import { setTimeout as sleep } from "node:timers/promises";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { launchGuests } from "./media.mjs";
import { proveAudioDecoded, proveSilenceFrom } from "./audio-decode.mjs";
import { createSpace, episodeEnd } from "./proofs.mjs";
import { captureReady } from "./call-artifacts.mjs";
import { mediaPlane, save, waitFor } from "./runtime.mjs";
import { expectedSources, finding, foreignParticipants, joinLimitMs, leakedSources, missingSources, recoveryLimitMs, stalledSources } from "./fleet-criteria.mjs";
import { scriptOf } from "./fleet-plan.mjs";
import { sample } from "./fleet-sample.mjs";

const pollMs = 250;
const settleMs = 1500;
const windowMs = 2000;
const automatic = { recording: "automatic", transcription: "on_demand" };
const on = () => ({ microphone: true, camera: true, screen: false });
const generatorLoad = () => Number((loadavg()[0] / cpus().length).toFixed(2));
const sampleAll = (pages) => Promise.all(pages.map(sample));

class Call {
  constructor(spec) {
    this.spec = spec;
    this.leaked = new Set();
    this.record = { id: spec.id, guests: spec.guests, plane: mediaPlane, recording: spec.recording, startedAt: Date.now(), faults: [], findings: [], actions: [] };
  }

  add(reason, detail) {
    this.record.findings.push(finding(reason, `${detail} (generator load ${generatorLoad()} per core)`));
  }

  // Each page is reported once: a leak is one finding, not one per poll.
  checkIsolation(samples) {
    samples.forEach((entry, index) => {
      const foreign = foreignParticipants(entry, this.participants);
      if (foreign.length && !this.leaked.has(index)) {
        this.leaked.add(index);
        this.add("cross_tenant", `Guest ${index + 1} saw ${foreign.length} participant(s) outside its call`);
      }
    });
  }
}

/** Polls until every page shows its expected sources advancing. Returns the elapsed ms, or null at the deadline. */
async function advancesWithin(call, limitMs) {
  const startedAt = performance.now();
  let previous = await sampleAll(call.pages);
  while (performance.now() - startedAt < limitMs) {
    await sleep(pollMs);
    const current = await sampleAll(call.pages);
    call.checkIsolation(current);
    if (current.every((after, index) => stalledSources(previous[index], after, call.state).length === 0)) return Math.round(performance.now() - startedAt);
    previous = current;
  }
  return null;
}

async function firstRender(call, startedAt) {
  for (;;) {
    const current = await sampleAll(call.pages);
    call.checkIsolation(current);
    const waiting = current.flatMap((entry) => missingSources(entry, call.state));
    if (waiting.length === 0) return Math.round(performance.now() - startedAt);
    if (performance.now() - startedAt > joinLimitMs + 15_000) return null;
    await sleep(pollMs);
  }
}

/**
 * Bytes advancing is not audio. Every guest whose microphone is on must be decoded as its tone at every other guest
 * (audio_not_decoded), and every muted guest must be silent there (mute_leak, a P1).
 */
async function checkAudio(call, label) {
  const everyone = call.pages.map((_, guest) => guest);
  const speaking = everyone.filter((guest) => call.state[call.participants[guest]].microphone);
  const pairs = speaking.flatMap((speaker) => everyone.filter((listener) => listener !== speaker).map((listener) => ({ listener, speaker })));
  if (pairs.length) await proveAudioDecoded(call.guests, { pairs }).catch((error) => call.add("audio_not_decoded", `${label}: ${error.message}`));
  for (const speaker of everyone.filter((guest) => !speaking.includes(guest))) await proveSilenceFrom(call.guests, speaker).catch((error) => call.add("mute_leak", `${label}: ${error.message}`));
}

/** True when nothing of `participants` in `off` reaches any other page across a two-second window. */
async function checkOff(call, guest, off, label) {
  await sleep(settleMs);
  const before = await sampleAll(call.pages);
  await sleep(windowMs);
  const after = await sampleAll(call.pages);
  const leaks = call.pages.flatMap((_, index) => (index === guest ? [] : leakedSources(before[index], after[index], call.participants[guest], off).map((source) => `${source} of guest ${guest + 1} reached guest ${index + 1}`)));
  if (leaks.length) call.add("mute_leak", `${label}: ${leaks.join("; ")}`);
  if (off.includes("microphone")) await proveSilenceFrom(call.guests, guest).catch((error) => call.add("mute_leak", `${label}: ${error.message}`));
}

const setLocal = (page, source, enabled) => page.evaluate(({ source, enabled }) => (source === "microphone" ? window.proofClient.media.setMicrophoneEnabled(enabled) : window.proofClient.media.setCameraEnabled(enabled)), { source, enabled });

// A leak check that never fires proves nothing: before a source is turned off, its energy or frames must visibly reach another guest.
async function detectorSees(call, guest, source) {
  const before = await sampleAll(call.pages);
  await sleep(1000);
  const after = await sampleAll(call.pages);
  const seen = call.pages.some((_, index) => index !== guest && leakedSources(before[index], after[index], call.participants[guest], [source]).includes(source));
  if (seen) return;
  call.add("detector_blind", `The ${source} of guest ${guest + 1} showed no audio flow or video frames at any other guest before it was turned off`);
  await save(join(call.run.directory, `blind-${source}-guest-${guest + 1}.json`), { before, after });
}

async function toggle(call, guest, source) {
  const page = () => call.pages[guest];
  await detectorSees(call, guest, source);
  await setLocal(page(), source, false);
  call.state[call.participants[guest]][source] = false;
  await checkOff(call, guest, [source], `${source} off`);
  await setLocal(page(), source, true);
  call.state[call.participants[guest]][source] = true;
  const ms = await advancesWithin(call, joinLimitMs);
  if (ms === null) call.add("action_failed", `${source} of guest ${guest + 1} did not render again within ${joinLimitMs / 1000} s after it was turned on`);
  else if (source === "microphone") await checkAudio(call, "microphone back on");
  call.record.actions.push({ kind: `${source}-toggle`, ms });
}

async function screenShare(call, guest) {
  const share = await call.pages[guest].context().newPage();
  await share.goto(`${call.origin}/share`);
  await call.pages[guest].bringToFront();
  await call.pages[guest].evaluate(() => window.proofClient.media.setScreenShareEnabled(true));
  await waitFor("screen share enabled", () => call.pages[guest].evaluate(() => window.proofClient.getSnapshot().media.screenShare.state === "enabled"), 30_000, 500);
  call.state[call.participants[guest]].screen = true;
  const ms = await advancesWithin(call, joinLimitMs + 5000);
  if (ms === null) call.add("action_failed", `Screen share of guest ${guest + 1} did not render for every guest`);
  await sleep(3000);
  await call.pages[guest].evaluate(() => window.proofClient.media.setScreenShareEnabled(false));
  call.state[call.participants[guest]].screen = false;
  await share.close();
  call.record.actions.push({ kind: "screen-share", ms });
}

async function rejoin(call, guest) {
  await call.guests.rejoin(guest);
  call.state[call.participants[guest]] = on();
  const ms = await advancesWithin(call, joinLimitMs);
  if (ms === null) call.add("action_failed", `Guest ${guest + 1} did not render again within ${joinLimitMs / 1000} s after it rejoined`);
  else await checkAudio(call, "after the rejoin");
  call.record.actions.push({ kind: "rejoin", ms });
}

async function provesStall(call) {
  // Camera video is the signal that cannot hide in a jitter buffer: it stalls for every guest or the fault did not bite.
  // Packets already queued at the provider can keep arriving for a moment, so the stall may start late: poll until the hold is nearly over.
  const cameras = Object.fromEntries(Object.entries(call.state).map(([id, state]) => [id, { microphone: false, camera: state.camera, screen: false }]));
  const stalledAt = (before, after) =>
    after.every((entry, index) => {
      const expected = expectedSources(cameras, entry.self).length;
      return expected === 0 || stalledSources(before[index], entry, cameras).length === expected;
    });
  const deadline = performance.now() + call.pulse.holdMs - 700;
  let before = await sampleAll(call.pages);
  for (;;) {
    await sleep(1200);
    const after = await sampleAll(call.pages);
    if (stalledAt(before, after)) return true;
    if (performance.now() > deadline) {
      await save(join(call.run.directory, `not-stalled-${call.record.id}.json`), { state: call.state, before, after });
      return false;
    }
    before = after;
  }
}

async function consentHolds(call) {
  const requested = call.participants.flatMap((id, guest) => ["microphone", "camera"].filter((source) => !call.state[id][source]).map((source) => ({ guest, source })));
  for (const { guest, source } of requested) {
    const local = await call.pages[guest].evaluate((name) => window.proofClient.getSnapshot().media.local[name].state, source);
    if (local === "enabled") call.add("consent_reenabled", `Recovery turned the ${source} of guest ${guest + 1} back on`);
  }
  const before = await sampleAll(call.pages);
  await sleep(windowMs);
  const after = await sampleAll(call.pages);
  for (const { guest, source } of requested) {
    const leaks = call.pages.flatMap((_, index) => (index === guest ? [] : leakedSources(before[index], after[index], call.participants[guest], [source])));
    if (leaks.length) call.add("consent_reenabled", `The ${source} of guest ${guest + 1} reached other guests after recovery`);
  }
}

/** Parks at a checkpoint; after a fault pulse, proves the stall, measures recovery and checks that nothing muted came back. */
async function checkpoint(call) {
  const fault = await call.pulse.checkpoint(call, () => provesStall(call));
  if (!fault) return;
  if (!fault.stalled) {
    call.add("fault_not_stalled", "The fault did not interrupt rendered media, so this recovery trial proves nothing");
    return;
  }
  const waited = Math.round(performance.now() - fault.restoredAt);
  const ms = await advancesWithin(call, recoveryLimitMs + 15_000 - Math.max(0, waited));
  const total = ms === null ? null : ms + Math.max(0, waited);
  if (total === null) call.add("recovery_not_rendered", `Media did not render again within ${(recoveryLimitMs + 15_000) / 1000} s after the path came back`);
  else {
    call.record.faults.push({ ms: total });
    if (total > recoveryLimitMs) call.add("recovery_over_limit", `Media rendered again ${total} ms after the path came back`);
  }
  await consentHolds(call);
  await checkAudio(call, "after recovery");
}

async function hold(call, seconds) {
  const until = performance.now() + seconds * 1000;
  while (performance.now() < until) {
    await checkpoint(call);
    await sleep(Math.min(1000, Math.max(0, until - performance.now())));
  }
}

const actionsByName = { microphone: (call, guest) => toggle(call, guest, "microphone"), camera: (call, guest) => toggle(call, guest, "camera"), screen: screenShare, rejoin };

async function open(call, ctx) {
  const { spec } = call;
  const lease = await ctx.spaces.acquire(spec.recording ? automatic : undefined);
  call.lease = lease;
  const episodePath = `${call.run.tenantPath}/spaces/${lease.space.id}/episodes`;
  const episode = await call.run.apiRequest("POST", episodePath, { metadata: { proof_run_id: ctx.run.runId } });
  call.episodePath = `${episodePath}/${episode.id}`;
  call.ending = episodeEnd(call.run, call.episodePath);
  call.record.episodeId = episode.id;
  call.guests = await launchGuests(call.run, lease.space, episode, null, ctx.origin, true, spec.guests, { deferJoin: true, camera: ctx.camera });
  call.pages = call.guests.pages;
  call.participants = call.guests.participants;
  call.state = Object.fromEntries(call.participants.map((id) => [id, on()]));
  call.ending.useSDK(call.pages[0]);
}

async function joinAll(call) {
  let lastStart = performance.now();
  for (let guest = 0; guest < call.pages.length; guest++) {
    lastStart = performance.now();
    try {
      await call.pages[guest].evaluate(({ slug, api, name }) => window.proofJoin(slug, api, name), { slug: call.lease.space.slug, api: call.run.config.api_url, name: `Proof guest ${guest + 1}` });
    } catch (error) {
      call.add("join_not_rendered", `Guest ${guest + 1} could not join: ${String(error.message).slice(0, 160)}`);
      return null;
    }
  }
  // Joins are timed from the last guest's join call, so browser startup and the earlier guests' joins are outside it.
  const ms = await firstRender(call, lastStart);
  if (ms === null) call.add("join_not_rendered", `Not every guest rendered the others within ${(joinLimitMs + 15_000) / 1000} s`);
  else {
    if (ms > joinLimitMs) call.add("join_over_limit", `The call rendered ${ms} ms after the last guest joined`);
    await checkAudio(call, "after the join");
  }
  return ms;
}

async function waitForCapture(call) {
  await waitFor("Capture ready", async () => captureReady(await call.pages[0].evaluate(() => window.proofClient.getSnapshot().recording.current)), 120_000, 2000);
}

/** Ends the Episode through the SDK, then the owner API. Returns the failure text, or undefined. */
async function endEpisode(call, ctx) {
  if (!call.ending) return undefined;
  try {
    await call.ending.end();
    return undefined;
  } catch {
    try {
      await episodeEnd(ctx.run, call.episodePath).end();
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
}

// A call that ends muted lets a fault pulse land on a muted microphone, and recovery must keep it off.
async function muteForGood(call, guest) {
  await setLocal(call.pages[guest], "microphone", false);
  call.state[call.participants[guest]].microphone = false;
  await checkOff(call, guest, ["microphone"], "microphone off before the final hold");
}

export async function runCall(ctx, spec) {
  const call = new Call(spec);
  call.origin = ctx.origin;
  call.pulse = ctx.pulse;
  call.run = { ...ctx.run, directory: join(ctx.run.directory, "calls", spec.id), resources: [] };
  await mkdir(call.run.directory, { recursive: true, mode: 0o700 });
  await ctx.pulse.enter(call);
  try {
    await open(call, ctx);
    const joinMs = await joinAll(call);
    if (joinMs !== null) {
      call.record.joinMs = joinMs;
      call.record.renderedAt = Date.now();
      if (spec.recording) await waitForCapture(call);
      for (const step of scriptOf(spec)) {
        if (step.hold) await hold(call, step.hold);
        else if (step.mute !== undefined) await muteForGood(call, step.mute);
        else await actionsByName[step.action.kind](call, step.action.guest);
        await checkpoint(call);
      }
      call.record.endedAt = Date.now();
    }
  } catch (error) {
    call.record.error = (error instanceof Error ? error.message : String(error)).slice(0, 240);
  } finally {
    ctx.pulse.leave(call);
  }
  const teardown = await endEpisode(call, ctx);
  if (teardown && !call.record.error) call.record.error = `The call's Episode did not end: ${teardown.slice(0, 160)}`;
  call.record.endedAt ??= Date.now();
  await save(join(call.run.directory, "call.json"), call.record).catch(() => {});
  await call.lease?.release();
  for (const resource of call.run.resources.splice(0)) await resource.dispose().catch(() => {});
  return call.record;
}
