// Turns the page traces of one action into stage durations (see features/scorecard/stages.mjs for what each stage covers).
// Pure functions over events {t, k, d} with t in ms on the host clock; the latency kit records them with latency-trace.mjs.
import { AUDIO_KEYS, RTT_KEYS, STAGE_GROUPS } from "../../features/scorecard/stages.mjs";
import { iceSummary } from "./latency-ice.mjs";
import { summarize } from "./latency-stats.mjs";

const find = (events, from, match) => events.find((event) => event.t >= from && match(event))?.t ?? null;
const httpEnd = (events, from, step) => find(events, from, (event) => event.k === "http_end" && event.d.split(" ")[1] === step);

// chain walks the stages in order. A stage counts from the last one reached, so a stage the SDK skipped leaves null and
// its time lands in the next stage that was reached. Durations are never negative: a reading before the previous one
// (a clock tick apart between two pages) counts as zero.
function chain(group, start, steps) {
  const durations = {};
  let previous = start;
  for (const [name, locate] of steps) {
    const at = locate(previous);
    if (at === null) {
      durations[`${group}.${name}`] = null;
      continue;
    }
    const reached = Math.max(at, previous);
    durations[`${group}.${name}`] = Math.round(reached - previous);
    previous = reached;
  }
  return durations;
}

// A stage that runs beside the chain counts from the call.
const sinceCall = (start, at) => (at === null ? null : Math.max(0, Math.round(at - start)));

/**
 * toggleStages splits one mic, camera or screen toggle.
 * @param {string} group  A group id such as "mic_on".
 * @param {{ t0: number, sender: any[], receiver: any[], command: string, visibleAt: number | null, finalAt: number | null }} trace
 *   command: the Sync frame the toggle sends, as "live_target:<name>:<enabled>". visibleAt: when the receiver's roster showed the change.
 *   finalAt: when the receiver got the first new frame or packet (turn on) or lost the track (turn off).
 */
export function toggleStages(group, { t0, sender, receiver, command, visibleAt, finalAt }) {
  const turningOn = group.endsWith("_on") || group.endsWith("_start");
  const sent = find(sender, t0, (event) => event.k === "ws_out" && event.d === command);
  const frame = sent === null || visibleAt === null ? null : (receiver.findLast((event) => event.k === "ws_in" && event.d === "projection_event:media" && event.t >= sent - 1 && event.t <= visibleAt)?.t ?? null);
  const ack = sent === null ? null : find(sender, sent, (event) => event.k === "ws_in" && event.d === "live_target_result");
  const duringSend = httpEnd(sender, t0, turningOn ? "tracks" : "tracks/close");
  const afterPrevious = (step) => (previous) => httpEnd(receiver, previous, step);
  const stages = chain(group, t0, [
    ["prepare", () => sent],
    ["sync_fanout", () => frame],
    ["roster_apply", () => visibleAt],
    ["list_publications", (previous) => httpEnd(receiver, frame ?? previous, "publications")],
    ...(turningOn
      ? [
          ["pull", afterPrevious("tracks")],
          ["renegotiate", afterPrevious("renegotiate")],
        ]
      : []),
    [turningOn ? "first_media" : "track_removed", () => finalAt],
  ]);
  return {
    ...stages,
    [`${group}.sync_ack`]: sinceCall(t0, ack),
    [`${group}.${turningOn ? "sfu_publish" : "sfu_close"}`]: sinceCall(t0, duringSend),
  };
}

/**
 * joinStages splits join() on the joining guest's own page.
 * @param {{ t0: number, events: any[] }} trace
 */
export function joinStages({ t0, events }) {
  const frame = (name) => (previous) => find(events, previous, (event) => event.k === "ws_in" && event.d === name);
  // A socket opened in the lobby is already open when join() starts, so the two socket stages cost nothing on the join path.
  const adopted = events.some((event) => event.k === "ws_open" && event.t < t0);
  const stages = chain("join", t0, [
    ["prepare", (previous) => (adopted ? previous : find(events, previous, (event) => event.k === "ws_new"))],
    ["sync_connect", (previous) => (adopted ? previous : find(events, previous, (event) => event.k === "ws_open"))],
    ["sync_welcome", frame("welcome")],
    ["sync_entered", frame("entered_ack")],
  ]);
  return {
    ...stages,
    // The combined pull-published request lists the publications inside the first tracks reply, so no list request
    // precedes it. A later GET publications (the video poll) is not the join's list, and the tracks stage carries the cost.
    "join.sfu_publications": events.some((event) => event.k === "pull_published" && event.t >= t0) ? null : sinceCall(t0, httpEnd(events, t0, "publications")),
    "join.sfu_tracks": sinceCall(t0, httpEnd(events, t0, "tracks")),
    "join.sfu_renegotiate": sinceCall(t0, httpEnd(events, t0, "renegotiate")),
    "join.ice_connected": sinceCall(
      t0,
      find(events, t0, (event) => event.k === "ice_connected"),
    ),
  };
}

/**
 * syncRoundTrip is the median round trip, in ms, of the SDK's own Sync pings that were answered. A pong answers the oldest ping in
 * flight, the way the SDK pairs them, and a new socket forgets the pings of the old one. A ping that is never answered pairs with
 * nothing, so the result is null when no ping was answered. The trace sends no ping of its own.
 * @param {{t: number, k: string, d?: string}[]} events
 * @returns {number | null}
 */
export function syncRoundTrip(events) {
  const inFlight = [];
  const trips = [];
  for (const event of events) {
    if (event.k === "ws_new") inFlight.length = 0;
    else if (event.k === "ws_out" && event.d === "ping") inFlight.push(event.t);
    else if (event.k === "ws_in" && event.d === "pong" && inFlight.length > 0) trips.push(event.t - inFlight.shift());
  }
  if (trips.length === 0) return null;
  const middle = trips.toSorted((left, right) => left - right)[Math.floor(trips.length / 2)];
  return Math.round(middle * 10) / 10;
}

const finite = (value) => Number.isFinite(value);
const tenth = (value) => Math.round(value * 10) / 10;

/**
 * audioPath estimates the delay a listener adds to audio, from two reads of the receiver's audio counters a steady window
 * apart and the SFU round trip measured on the sender's and the receiver's side. media.network_jitter_one_way_ms is the network
 * time plus the jitter buffer; capture, encode, SFU forwarding and playout are not in it, and media.playout_ms is reported beside it.
 * Every part is null when the window cannot show it: no audio was emitted, the browser reports no playout delay, or no round trip was read.
 * @param {{ emitted: number, jitterBufferDelay: number, samples: number, playoutDelay: number, playoutReported: boolean }} before
 * @param {{ emitted: number, jitterBufferDelay: number, samples: number, playoutDelay: number, playoutReported: boolean }} after
 * @param {{ sender: number | null, receiver: number | null }} rtt  The SFU round trip in ms from each guest.
 * @returns {Record<string, number | null>}
 */
export function audioPath(before, after, rtt) {
  const emitted = after.emitted - before.emitted;
  const samples = after.samples - before.samples;
  const jitterBuffer = emitted > 0 ? ((after.jitterBufferDelay - before.jitterBufferDelay) / emitted) * 1000 : null;
  const playout = after.playoutReported && samples > 0 ? ((after.playoutDelay - before.playoutDelay) / samples) * 1000 : null;
  const sender = finite(rtt.sender) ? rtt.sender : rtt.receiver;
  const receiver = finite(rtt.receiver) ? rtt.receiver : rtt.sender;
  const network = finite(sender) && finite(receiver) ? (sender + receiver) / 2 : null;
  const total = finite(network) && finite(jitterBuffer) && jitterBuffer >= 0 ? network + jitterBuffer : null;
  const round = (value) => (finite(value) && value >= 0 ? tenth(value) : null);
  return { "media.network_jitter_one_way_ms": round(total), "media.network_ms": round(network), "media.jitter_buffer_ms": round(jitterBuffer), "media.playout_ms": round(playout) };
}

/**
 * diagnosticsOf is the summary of the diagnostics sidecar: n, p50 and p95 of every round trip and stage over the kept cycles.
 * It returns undefined when no cycle carries a trace, so a run without tracing writes no sidecar.
 * @param {{ trace?: { rtt: Record<string, number | null>, stages: Record<string, number | null>, audio?: Record<string, number | null>, ice?: import("./latency-ice.mjs").IceReading } }[]} cycles
 */
export function diagnosticsOf(cycles) {
  const traced = cycles.flatMap((cycle) => (cycle.trace ? [cycle.trace] : []));
  if (!traced.length) return undefined;
  const stat = (summary) => ({ n: summary.n, p50: summary.p50, p95: summary.p95 });
  const block = (samples, keys) => {
    const summary = summarize(samples);
    return Object.fromEntries(keys.filter((key) => summary[key]).map((key) => [key, stat(summary[key])]));
  };
  const audio = traced.flatMap((trace) => (trace.audio ? [trace.audio] : []));
  const ice = iceSummary(traced.map((trace) => trace.ice));
  const stageIds = STAGE_GROUPS.flatMap((group) => group.stages.map((stage) => `${group.id}.${stage.id}`));
  return {
    rtt: block(
      traced.map((trace) => trace.rtt),
      RTT_KEYS,
    ),
    stages: block(
      traced.map((trace) => trace.stages),
      stageIds,
    ),
    ...(audio.length ? { audio: block(audio, AUDIO_KEYS) } : {}),
    ...(ice ? { ice } : {}),
  };
}
