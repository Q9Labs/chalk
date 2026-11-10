// The long-call proof judges a call held across media-access refreshes. This file holds the schedule and the pass/fail rules and does no I/O,
// so a recorded run can be judged without a browser. long-call.mjs gathers the samples these rules read.
import { unheardAfterUnmute } from "./audio-decode.mjs";

// apps/api/internal/accessgrants/types.go Lifetime and sdks/typescript/client/src/access/manager.ts DEFAULT_REFRESH_WINDOW_MS.
// long-call.test.mjs reads both files and fails when either number moves.
export const accessLifetimeMs = 5 * 60_000;
export const refreshWindowMs = 60_000;
/** A grant is renewed this long after it was issued. */
export const refreshIntervalMs = accessLifetimeMs - refreshWindowMs;
const minimumDurationMs = 10 * 60_000;
/** Two full lifetimes, so the call outlives every first-generation credential, and never under ten minutes. */
export const callDurationMs = Math.max(minimumDurationMs, 2 * accessLifetimeMs);

export const bounds = {
  /** Outbound audio may stand still this long while the guest's microphone shows on. */
  outboundStallMs: 8000,
  /** A remote tile may stand still this long while its sender is on. */
  inboundStallMs: 10_000,
  /** No connected peer connection, or a status other than live, may last this long. */
  disconnectedMs: 10_000,
  /** A toggle counts as testing a refresh when it falls this close to the refresh request. */
  acrossRefreshMs: 10_000,
  /** A grant's successor must be requested within this long after the grant's refresh point (its expiry less the refresh window). */
  refreshLateMs: 30_000,
  sampleIntervalMs: 2000,
  /** The Chalk SFU node refuses an SDP offer over 64 KiB (HTTP 400). A signaling request this large means the offer is about to hit that cliff, so fail while the call still works. */
  signalBytes: 48 * 1024,
};

const baselineToggleMs = [60_000, 120_000, 180_000, 330_000, 390_000, 540_000];

/**
 * Guest 1 mutes its microphone and unmutes it, and guest 2 (the second to join, so the one that pulled guest 1's microphone first) does the same right after.
 * Guest 2 must keep its peer connection through guest 1's mute and through its own, and that is early enough to fail the call before the long hold.
 */
const muteRelay = [...offOn(20_000, 0, "microphone"), ...offOn(30_000, 1, "microphone")];

/** The baseline toggles, which do not depend on when a refresh happens. */
export function baselineToggles() {
  return [...muteRelay, ...baselineToggleMs.flatMap((atMs, index) => offOn(atMs, index % 2, index % 4 < 2 ? "microphone" : "camera"))];
}

function offOn(atMs, guest, kind) {
  return [
    { atMs, guest, kind, enabled: false },
    { atMs: atMs + 6000, guest, kind, enabled: true },
  ];
}

/**
 * The toggles around one access refresh due at `dueMs`: guests 1 and 2 (indexes 0 and 1) toggle 8 s before and 2 to 6 s after it,
 * so a refresh within 2 s of `dueMs` has a toggle on either side within the bound.
 */
export function refreshToggles(dueMs) {
  return [...offOn(dueMs - 8000, 0, "microphone"), ...offOn(dueMs - 4000, 1, "camera"), ...offOn(dueMs + 2000, 1, "microphone"), ...offOn(dueMs - 2000, 0, "camera")];
}

/**
 * The toggle groups to add at `nowMs`. `dues` lists each guest's pending refresh as `{ key, dueMs }`, where `key` changes whenever the guest gets a new grant;
 * `planned` remembers the keys already planned. Every refresh gets its own group, because refreshes of different guests can be a few seconds apart and one
 * group covers only the 2 s around its due time. A refresh with less than 9 s left, or whose group would run past the end of the call, gets none.
 */
export function planRefreshToggles({ dues, nowMs, planned, durationMs = callDurationMs }) {
  const toggles = [];
  for (const { key, dueMs } of dues) {
    if (planned.has(key) || dueMs <= nowMs + 9000 || dueMs + 10_000 >= durationMs) continue;
    planned.add(key);
    toggles.push(...refreshToggles(dueMs));
  }
  return toggles;
}

/**
 * The toggles of one call if every guest renews its grant at the predicted time, as `{ atMs, guest, kind, enabled }` sorted by time from the
 * start of the call. Guest 3 only listens and speaks. A real call plans the refresh toggles from each guest's current grant instead
 * (long-call.mjs), because a media-connection replacement issues a new grant and moves the next refresh.
 */
export function toggleSchedule({ durationMs = callDurationMs, firstRefreshMs = refreshIntervalMs } = {}) {
  const toggles = baselineToggles();
  for (let boundary = firstRefreshMs; boundary + 10_000 < durationMs; boundary += refreshIntervalMs) toggles.push(...refreshToggles(boundary));
  return toggles.filter((toggle) => toggle.atMs + 1000 < durationMs).sort((a, b) => a.atMs - b.atMs);
}

/** Whether a byte counter moved. A drop to a positive value is a new peer connection that has started sending; zero is nothing. */
const moved = (previous, current) => current != null && current > 0 && current !== previous;

/**
 * Finds stretches where `bytes` stood still while `on` held. The clock starts at the last movement or the moment `on` last turned true.
 * Returns the stretches longer than the bound as `{ fromMs, toMs }`, relative to the first tick.
 */
function stalls(ticks, series, limitMs) {
  const found = [];
  let previous = null;
  let since = null;
  let open = null;
  for (const tick of ticks) {
    const { on, bytes } = series(tick);
    if (!on) {
      since = null;
      previous = bytes;
      open = null;
      continue;
    }
    since ??= tick.t;
    if (moved(previous, bytes)) {
      since = tick.t;
      open = null;
    } else if (tick.t - since > limitMs) {
      if (!open) {
        open = { fromMs: since - ticks[0].t, toMs: tick.t - ticks[0].t };
        found.push(open);
      } else open.toMs = tick.t - ticks[0].t;
    }
    previous = bytes;
  }
  return found;
}

function stretches(ticks, bad, limitMs) {
  const found = [];
  let from = null;
  for (const tick of ticks) {
    if (!bad(tick)) {
      from = null;
      continue;
    }
    from ??= tick.t;
    if (tick.t - from <= limitMs) continue;
    const last = found.at(-1);
    if (last?.fromMs === from - ticks[0].t) last.toMs = tick.t - ticks[0].t;
    else found.push({ fromMs: from - ticks[0].t, toMs: tick.t - ticks[0].t });
  }
  return found;
}

/** The sample of a page that did not answer in time. */
export const unreachableSample = { reachable: false, status: "unreachable", errorCode: null, mic: false, camera: false, pcs: [], outAudio: 0, remotes: [] };

const seconds = (ms) => Math.round(ms / 1000);
const span = ({ fromMs, toMs }) => `+${seconds(fromMs)}s to +${seconds(toMs)}s`;

/**
 * Walks one guest's grants in order. Each grant must be followed by a renewal requested no later than `refreshLateMs` after its refresh point
 * (expiry less the window), and the last grant must not be overdue when the call ends. A renewal may come early, because a media-connection
 * replacement issues a new grant too, and that moves the next refresh.
 */
function grantChainFailures({ initialExpiry, requests }, endMs, startedAtMs) {
  const failures = [];
  let expiry = initialExpiry;
  for (const request of requests.filter((entry) => entry.status === 201)) {
    const lateMs = Date.parse(request.startedAt) - (expiry - refreshWindowMs);
    if (lateMs > bounds.refreshLateMs) failures.push(`renewed its access at +${seconds(Date.parse(request.startedAt) - startedAtMs)}s, ${seconds(lateMs)} s after the refresh was due`);
    expiry = request.mediaExpiry;
  }
  if (endMs - (expiry - refreshWindowMs) > bounds.refreshLateMs) failures.push(`did not renew its access, due at +${seconds(expiry - refreshWindowMs - startedAtMs)}s, before the call ended`);
  return failures;
}

/** How far from a reported section_budget rotation a replacement request or a closed peer connection can be and still belong to it. */
const rotationMatchMs = 30_000;

/** The events no reported rotation explains. Each rotation (the epoch time of its signaling request) explains the nearest unexplained event within the window, so an unplanned event keeps failing whatever its order. */
function unplanned(events, rotations) {
  const free = [...rotations].sort((a, b) => a - b);
  return events.filter(({ atMs }) => {
    const index = free.findIndex((rotationMs) => Math.abs(rotationMs - atMs) <= rotationMatchMs);
    if (index < 0) return true;
    free.splice(index, 1);
    return false;
  });
}

/** The proof injects no fault, so a media-connection replacement is the SDK recovering from a break it should not have had, unless its own report says it rotated for the offer size. */
function replacementFailures(refreshes, startedAtMs, budgetReplacements) {
  return refreshes.flatMap(({ guest, requests }) => {
    const replacements = requests.filter((request) => request.replaceMediaConnection).map((request) => ({ request, atMs: Date.parse(request.startedAt) }));
    return unplanned(replacements, budgetReplacements[guest - 1] ?? []).map(({ request, atMs }) => `Guest ${guest} replaced its media connection at +${seconds(atMs - startedAtMs)}s (${request.reason ?? "no reason"}, status ${request.status ?? "none"}) with no fault injected`);
  });
}

/** Peer connections that left "connected" after reaching it, once each. A closed one counts: the SDK only closes a connection it replaces. */
function leftConnectedFailures(own, label, firstTick, budgetReplacements) {
  const connected = new Set();
  const reported = new Set();
  const left = [];
  for (const sample of own.filter((entry) => entry.reachable)) {
    sample.pcs.forEach((state, index) => {
      if (state === "connected") connected.add(index);
      else if (connected.has(index) && !reported.has(index)) {
        reported.add(index);
        left.push({ atMs: sample.t, state, failure: `${label} peer connection ${index + 1} left connected for ${state} at +${seconds(sample.t - firstTick)}s` });
      }
    });
  }
  // A rotation closes the old connection; a connection that disconnects or fails first left for another reason, whatever the rotations.
  const closures = unplanned(
    left.filter(({ state }) => state === "closed"),
    budgetReplacements,
  );
  return left.filter((event) => event.state !== "closed" || closures.includes(event)).map(({ failure }) => failure);
}

/** Every microphone turned back on was decoded again by each other guest. A turn-on nobody checked fails too, so the check cannot be skipped by leaving it out. */
function hearingFailures({ toggles, hearings, guests }) {
  const failures = [];
  for (const toggle of toggles.filter((entry) => entry.kind === "microphone" && entry.enabled)) {
    const found = hearings.find((hearing) => hearing.speaker === toggle.guest && hearing.atMs === toggle.atMs);
    const at = `+${seconds(toggle.atMs)}s`;
    if (!found) failures.push(`Guest ${toggle.guest + 1}'s microphone turned back on at ${at} was never checked for being heard`);
    else if (found.verdicts.length < guests - 1) failures.push(`Guest ${toggle.guest + 1}'s microphone turned back on at ${at} was checked at ${found.verdicts.length} of ${guests - 1} other guests`);
    else failures.push(...unheardAfterUnmute(toggle.guest, found.verdicts).map((text) => `${text}; turned back on at ${at}`));
  }
  return failures;
}

/**
 * @param ticks `{ t, guests: [sample] }` in time order; a sample is `{ reachable, status, errorCode, mic, camera, pcs, outAudio, remotes: [{ participantId, source, bytes }] }`.
 * @param participants The participant id of each guest, in guest order.
 * @param refreshes What each guest's credential provider saw: `{ guest, requests: [{ status, replaceMediaConnection, startedAt }] }`.
 * @param toggles The toggles that ran, as `{ atMs, guest, kind, enabled }` from the start of the call.
 * @param hearings What the other guests decoded after each microphone turned back on: `{ speaker, atMs, verdicts: [{ listener, pass, ... }] }`, one per such toggle
 *   (audio-decode.mjs hearAfterUnmute) with a verdict for every other guest. Advancing bytes do not count, so a guest left deaf by a re-publish fails here.
 * @returns `{ failures, notes, evidence }`; the run passes when `failures` is empty.
 */
/** `signalBytes` is the largest signaling request body each guest sent and `budgetReplacements` the epoch time of each signaling request in which a guest's SDK reported replacing its connection to keep offers under the node's cap, when the proof measured them. */
export function judgeLongCall({ ticks, participants, refreshes, toggles, hearings, startedAtMs, signalBytes = [], budgetReplacements = [] }) {
  const failures = [];
  const guests = participants.length;
  const label = (guest) => `Guest ${guest + 1}`;
  for (let guest = 0; guest < guests; guest++) {
    const own = ticks.map((tick) => ({ ...tick.guests[guest], t: tick.t }));
    const lost = own.find((sample) => sample.errorCode === "access.invalid" || sample.status === "failed" || sample.status === "left");
    if (lost) failures.push(`${label(guest)} lost the call at +${seconds(lost.t - ticks[0].t)}s: status ${lost.status}, error ${lost.errorCode ?? "none"}`);
    for (const stretch of stretches(own, (sample) => !sample.reachable || sample.status !== "live", bounds.disconnectedMs)) {
      failures.push(`${label(guest)} was not live for more than ${seconds(bounds.disconnectedMs)} s (${span(stretch)})`);
    }
    for (const stretch of stretches(own, (sample) => sample.reachable && !sample.pcs.includes("connected"), bounds.disconnectedMs)) {
      failures.push(`${label(guest)} had no connected peer connection for more than ${seconds(bounds.disconnectedMs)} s (${span(stretch)}); a closed one was not replaced`);
    }
    failures.push(...leftConnectedFailures(own, label(guest), ticks[0].t, budgetReplacements[guest] ?? []));
    if ((signalBytes[guest] ?? 0) > bounds.signalBytes)
      failures.push(`${label(guest)} sent a signaling request of ${signalBytes[guest]} bytes, over the ${bounds.signalBytes} byte limit that keeps its offer clear of the node's 64 KiB cap; the offer grows with every media section the connection has closed`);
    for (const stretch of stalls(own, (sample) => ({ on: sample.mic, bytes: sample.outAudio }), bounds.outboundStallMs)) {
      failures.push(`${label(guest)} sent no audio for ${seconds(stretch.toMs - stretch.fromMs)} s (${span(stretch)}) while its microphone showed on`);
    }
  }
  for (let viewer = 0; viewer < guests; viewer++) {
    for (let sender = 0; sender < guests; sender++) {
      if (sender === viewer) continue;
      for (const [source, flag] of [
        ["microphone", "mic"],
        ["camera", "camera"],
      ]) {
        const series = (tick) => {
          const own = tick.guests[viewer];
          const sending = tick.guests[sender];
          const tile = own.remotes.find((remote) => remote.participantId === participants[sender] && remote.source === source);
          return { on: own.reachable && sending.reachable && sending[flag], bytes: tile?.bytes ?? null };
        };
        for (const stretch of stalls(ticks, series, bounds.inboundStallMs)) {
          failures.push(`${label(viewer)} received no ${source === "camera" ? "video" : "audio"} from ${label(sender).toLowerCase()} for ${seconds(stretch.toMs - stretch.fromMs)} s (${span(stretch)}) while it was on`);
        }
      }
    }
  }
  const grantCounts = refreshes.map(({ requests }) => requests.filter((request) => request.status === 201).length);
  const scheduledCounts = refreshes.map(({ requests }) => requests.filter((request) => !request.replaceMediaConnection && request.status === 201).length);
  for (const { guest, requests } of refreshes) {
    for (const request of requests.filter((entry) => entry.status !== 201)) failures.push(`${label(guest - 1)}'s access refresh failed with status ${request.status ?? "none"}${request.code ? ` (${request.code})` : ""}`);
  }
  const endMs = ticks.at(-1)?.t ?? startedAtMs;
  const notes = [];
  const refreshMs = refreshes.flatMap(({ requests }) => requests.filter((request) => !request.replaceMediaConnection).map((request) => Date.parse(request.startedAt) - startedAtMs));
  // A refresh in the last 10 s of the call has no room for a toggle after it. It is not toggle-tested, but it is still counted and its grant is still judged below.
  const testable = refreshMs.filter((at) => at + bounds.acrossRefreshMs <= endMs - startedAtMs);
  for (const at of refreshMs.filter((at) => !testable.includes(at))) notes.push(`The access refresh at +${seconds(at)}s fell in the last ${seconds(bounds.acrossRefreshMs)} s of the call, so no toggle could follow it; it was not toggle-tested`);
  const untested = testable.filter((at) => !toggles.some((toggle) => toggle.atMs >= at - bounds.acrossRefreshMs && toggle.atMs <= at) || !toggles.some((toggle) => toggle.atMs >= at && toggle.atMs <= at + bounds.acrossRefreshMs));
  if (untested.length) failures.push(`${untested.length} access refresh(es) at ${untested.map((at) => `+${seconds(at)}s`).join(", ")} had no mic or camera toggle on each side within ${seconds(bounds.acrossRefreshMs)} s, so they were not tested`);
  failures.push(...replacementFailures(refreshes, startedAtMs, budgetReplacements));
  failures.push(...hearingFailures({ toggles, hearings, guests }));
  for (const refresh of refreshes) failures.push(...grantChainFailures(refresh, endMs, startedAtMs).map((text) => `${label(refresh.guest - 1)} ${text}`));
  const fewest = Math.min(...grantCounts);
  const fewestScheduled = Math.min(...scheduledCounts);
  if (!(fewest >= 2 && fewestScheduled >= 1)) failures.push(`Guests renewed their access ${grantCounts.join(", ")} times (${scheduledCounts.join(", ")} scheduled); at least 2 each, with at least 1 scheduled, were expected in this call`);
  return {
    failures,
    notes,
    evidence: {
      guests,
      durationSeconds: seconds((ticks.at(-1)?.t ?? 0) - (ticks[0]?.t ?? 0)),
      refreshesSeen: fewest,
      toggles: toggles.length,
      maxSignalBytes: Math.max(0, ...signalBytes),
      failureCount: failures.length,
    },
  };
}

export function evidenceLine({ guests, durationSeconds, refreshesSeen, toggles, maxSignalBytes, failureCount }) {
  return `Long call: ${guests} guests, ${durationSeconds}s, ${refreshesSeen} access refreshes seen, ${toggles} mic/camera toggles, largest signaling request ${maxSignalBytes} bytes, ${failureCount} failures`;
}
