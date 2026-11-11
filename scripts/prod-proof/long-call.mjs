import { launchGuests } from "./media.mjs";
import { hearAfterUnmute } from "./audio-decode.mjs";
import { createEpisode, createSpace } from "./proofs.mjs";
import { baselineToggles, bounds, callDurationMs, evidenceLine, judgeLongCall, planRefreshToggles, refreshIntervalMs, refreshWindowMs, toggleSchedule, unreachableSample } from "./long-call-criteria.mjs";
import { check, mediaPlane, save } from "./runtime.mjs";

const guestCount = Number(process.env.LONG_CALL_GUESTS ?? 3);
if (!Number.isInteger(guestCount) || guestCount < 3 || guestCount > 12) {
  throw new Error("LONG_CALL_GUESTS must be an integer from 3 to 12");
}
const sampleTimeoutMs = 5000;

/** Runs in the page: what one guest reports about its call. Self-contained, because Playwright serializes it. */
async function browserSample() {
  const snapshot = window.proofClient.getSnapshot();
  const received = new Map();
  let outAudio = 0;
  for (const connection of window.proofConnections) {
    if (connection.connectionState === "closed") continue;
    // A connection that closes between the state read and the stats read is being replaced; the next sample sees its successor.
    const rows = await connection.getStats().catch(() => new Map());
    for (const row of rows.values()) {
      if (row.type === "outbound-rtp" && row.kind === "audio") outAudio += row.bytesSent;
      if (row.type === "inbound-rtp") received.set(row.trackIdentifier, row.bytesReceived);
    }
  }
  return {
    reachable: true,
    status: snapshot.connection.status,
    errorCode: snapshot.connection.lastError?.code ?? null,
    mic: snapshot.media.local.microphone.state === "enabled",
    camera: snapshot.media.local.camera.state === "enabled",
    pcs: window.proofConnections.map((connection) => connection.connectionState),
    outAudio,
    remotes: snapshot.media.remote.filter((entry) => entry.source === "microphone" || entry.source === "camera").map((entry) => ({ participantId: entry.participantId, source: entry.source, bytes: received.get(entry.track.id) ?? null })),
  };
}

const sampleGuest = (page) => Promise.race([page.evaluate(browserSample), new Promise((resolve) => setTimeout(() => resolve(unreachableSample), sampleTimeoutMs))]).catch(() => unreachableSample);

/** The plan `pnpm prod:proof long-call --dry-run` prints; it needs no configuration and opens no connection. */
export function longCallPlan() {
  const schedule = toggleSchedule({ guestCount });
  return [
    `Long call: ${guestCount} guests on ${mediaPlane}, ${callDurationMs / 1000}s (the longer of 10 minutes and two ${refreshIntervalMs / 1000 + refreshWindowMs / 1000}s access lifetimes)`,
    `Access refresh every ${refreshIntervalMs / 1000}s after a grant; the schedule below assumes the first refresh at +${refreshIntervalMs / 1000}s of the call`,
    `Samples every ${bounds.sampleIntervalMs / 1000}s; fails on a lost call, outbound audio still for ${bounds.outboundStallMs / 1000}s, inbound audio or video still for ${bounds.inboundStallMs / 1000}s, or no connected peer connection for ${bounds.disconnectedMs / 1000}s`,
    ...schedule.map(({ atMs, guest, kind, enabled }) => `+${String(atMs / 1000).padStart(4)}s guest ${guest + 1} ${kind} ${enabled ? "on" : "off"}`),
  ].join("\n");
}

async function toggle(page, { kind, enabled }) {
  await page.evaluate(({ kind: target, enabled: value }) => (target === "microphone" ? window.proofClient.media.setMicrophoneEnabled(value) : window.proofClient.media.setCameraEnabled(value)), { kind, enabled });
}

export async function longCallProof(run, receiver) {
  const space = await createSpace(run, mediaPlane);
  const { episode, end } = await createEpisode(run, space);
  run.episodeId = episode.id;
  console.log(`Joining ${guestCount} synthetic camera/voice guests on ${mediaPlane}`);
  const guests = await launchGuests(run, space, episode, "", receiver.origin, true, guestCount);
  const startedAtMs = Date.now();
  const dueMs = (refresh) => refresh.currentExpiry - refreshWindowMs - startedAtMs;
  console.log(`Holding the call for ${callDurationMs / 1000}s; first access refresh due at +${Math.round(Math.min(...guests.refreshes.map(dueMs)) / 1000)}s; toggles around each refresh are planned from each guest's current grant`);

  const ticks = [];
  const failures = [];
  const ran = [];
  // Every microphone turned back on is a re-publish. Each other guest must decode it within a few seconds, checked while the schedule goes on.
  const hearings = [];
  const sampling = (async () => {
    while (Date.now() - startedAtMs < callDurationMs) {
      const t = Date.now();
      ticks.push({ t, guests: await Promise.all(guests.pages.map(sampleGuest)) });
      await run.wait(Math.max(0, bounds.sampleIntervalMs - (Date.now() - t)));
    }
  })();
  // A media-connection replacement issues a new grant and moves that guest's next refresh, so the toggles around a refresh are planned from the current grants.
  const toggling = (async () => {
    const pending = baselineToggles();
    const planned = new Set();
    while (Date.now() - startedAtMs < callDurationMs) {
      const now = Date.now() - startedAtMs;
      pending.push(...planRefreshToggles({ dues: guests.refreshes.map((refresh) => ({ key: `${refresh.guest}:${refresh.currentExpiry}`, guest: refresh.guest - 1, dueMs: dueMs(refresh) })), nowMs: now, planned }));
      pending.sort((a, b) => a.atMs - b.atMs);
      while (pending.length && pending[0].atMs <= now) {
        const entry = pending.shift();
        const turnedOnAt = Date.now();
        try {
          await toggle(guests.pages[entry.guest], entry);
          const turned = { ...entry, atMs: Date.now() - startedAtMs };
          ran.push(turned);
          if (entry.kind === "microphone" && entry.enabled) hearings.push(hearAfterUnmute(guests, entry.guest, { turnedOnAt }).then((verdicts) => ({ speaker: entry.guest, atMs: turned.atMs, verdicts })));
        } catch (error) {
          failures.push(`Guest ${entry.guest + 1} could not turn its ${entry.kind} ${entry.enabled ? "on" : "off"} at +${Math.round(now / 1000)}s: ${String(error.message).split("\n")[0]}`);
        }
      }
      await run.wait(500);
    }
  })();
  await Promise.all([sampling, toggling]);
  const heard = await Promise.all(hearings);
  const networkEvents = guests.networks.flat();
  const signalingRequestFailures = networkEvents.filter((event) => event.type === "request-failed").length;
  const signaling400Responses = networkEvents.filter((event) => event.type === "signaling-response" && event.status === 400).length;
  const budgetReplacementEvidence = guests.budgetReplacements.map((atMs, guest) => ({ guest: guest + 1, count: atMs.length, causes: atMs.map(() => "section_budget"), atMs }));
  const hearingVerdicts = heard.flatMap((hearing) => hearing.verdicts);
  const hearingPasses = hearingVerdicts.filter((verdict) => verdict.pass).length;
  if (signalingRequestFailures) failures.push(`${signalingRequestFailures} signaling request(s) failed`);
  if (signaling400Responses) failures.push(`${signaling400Responses} signaling request(s) returned HTTP 400`);

  const judged = judgeLongCall({ ticks, participants: guests.participants, refreshes: guests.refreshes, toggles: ran, hearings: heard, startedAtMs, signalBytes: guests.signalBytes, budgetReplacements: guests.budgetReplacements });
  failures.push(...judged.failures);
  const evidence = { ...judged.evidence, signalRequestFailures, signaling400Responses, budgetReplacements: budgetReplacementEvidence, hearingPasses, hearingFailures: hearingVerdicts.length - hearingPasses, failureCount: failures.length };
  console.log(evidenceLine(evidence));
  console.log(`Signaling requests: ${signalingRequestFailures} failed, ${signaling400Responses} HTTP 400 responses`);
  const replacements = budgetReplacementEvidence.filter((entry) => entry.count).map((entry) => `G${entry.guest} ${entry.count} (${[...new Set(entry.causes)].join(", ")})`);
  console.log(`Budget replacements: ${replacements.length ? replacements.join("; ") : "none"}`);
  console.log(`hearAfterUnmute: ${hearingPasses}/${hearingVerdicts.length} listener-speaker decodes passed`);
  for (const note of judged.notes) console.log(`Long call note: ${note}`);
  for (const failure of failures) console.log(`Long call failure: ${failure}`);
  await save(`${run.directory}/long-call.json`, { evidence, failures, toggles: ran, hearings: heard, ticks });
  await end();
  for (const page of guests.pages) await page.context().close();
  check(!failures.length, failures.join("; "));
  return evidence;
}
