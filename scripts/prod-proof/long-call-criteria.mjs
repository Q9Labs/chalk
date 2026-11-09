// The long-call proof judges a call held across media-access refreshes. This file holds the schedule and the pass/fail rules and does no I/O,
// so a recorded run can be judged without a browser. long-call.mjs gathers the samples these rules read.

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
  sampleIntervalMs: 2000,
};

const baselineToggleMs = [60_000, 120_000, 180_000, 330_000, 390_000, 540_000];

/**
 * The toggles of one call, as `{ atMs, guest, kind, enabled }` sorted by time from the start of the call.
 * Guests 1 and 2 (indexes 0 and 1) toggle, guest 3 only listens and speaks. Around each predicted refresh both guests toggle
 * 8 s before and 2 to 6 s after it, so each refresh has a toggle on either side within the bound.
 */
export function toggleSchedule({ durationMs = callDurationMs, firstRefreshMs = refreshIntervalMs } = {}) {
  const toggles = [];
  const off = (atMs, guest, kind) => toggles.push({ atMs, guest, kind, enabled: false }, { atMs: atMs + 6000, guest, kind, enabled: true });
  baselineToggleMs.forEach((atMs, index) => off(atMs, index % 2, index % 4 < 2 ? "microphone" : "camera"));
  for (let boundary = firstRefreshMs; boundary + 10_000 < durationMs; boundary += refreshIntervalMs) {
    off(boundary - 8000, 0, "microphone");
    off(boundary - 4000, 1, "camera");
    off(boundary + 2000, 1, "microphone");
    off(boundary - 2000, 0, "camera");
  }
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
 * @param ticks `{ t, guests: [sample] }` in time order; a sample is `{ reachable, status, errorCode, mic, camera, pcs, outAudio, remotes: [{ participantId, source, bytes }] }`.
 * @param participants The participant id of each guest, in guest order.
 * @param refreshes What each guest's credential provider saw: `{ guest, requests: [{ status, replaceMediaConnection, startedAt }] }`.
 * @param toggles The toggles that ran, as `{ atMs, guest, kind, enabled }` from the start of the call.
 * @returns `{ failures, evidence }`; the run passes when `failures` is empty.
 */
export function judgeLongCall({ ticks, participants, refreshes, toggles, startedAtMs }) {
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
  const refreshCounts = refreshes.map(({ requests }) => requests.filter((request) => !request.replaceMediaConnection && request.status === 201).length);
  for (const { guest, requests } of refreshes) {
    for (const request of requests.filter((entry) => entry.status !== 201)) failures.push(`${label(guest - 1)}'s access refresh failed with status ${request.status ?? "none"}${request.code ? ` (${request.code})` : ""}`);
  }
  const refreshMs = refreshes.flatMap(({ requests }) => requests.filter((request) => !request.replaceMediaConnection).map((request) => Date.parse(request.startedAt) - startedAtMs));
  const untested = refreshMs.filter((at) => !toggles.some((toggle) => Math.abs(toggle.atMs - at) <= bounds.acrossRefreshMs));
  if (untested.length) failures.push(`${untested.length} access refresh(es) at ${untested.map((at) => `+${seconds(at)}s`).join(", ")} had no mic or camera toggle within ${seconds(bounds.acrossRefreshMs)} s, so they were not tested`);
  const expectedRefreshes = Math.floor((ticks.at(-1)?.t - ticks[0]?.t) / refreshIntervalMs);
  const fewest = Math.min(...refreshCounts);
  if (!(fewest >= expectedRefreshes && fewest >= 2)) failures.push(`Guests saw ${refreshCounts.join(", ")} access refreshes; at least ${Math.max(2, expectedRefreshes)} each were expected in this call`);
  return {
    failures,
    evidence: {
      guests,
      durationSeconds: seconds((ticks.at(-1)?.t ?? 0) - (ticks[0]?.t ?? 0)),
      refreshesSeen: fewest,
      toggles: toggles.length,
      failureCount: failures.length,
    },
  };
}

export function evidenceLine({ guests, durationSeconds, refreshesSeen, toggles, failureCount }) {
  return `Long call: ${guests} guests, ${durationSeconds}s, ${refreshesSeen} access refreshes seen, ${toggles} mic/camera toggles, ${failureCount} failures`;
}
