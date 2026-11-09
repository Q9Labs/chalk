// Turns the page traces of one action into stage durations (see features/scorecard/stages.mjs for what each stage covers).
// Pure functions over events {t, k, d} with t in ms on the host clock; the latency kit records them with latency-trace.mjs.
import { RTT_KEYS, STAGE_GROUPS } from "../../features/scorecard/stages.mjs";
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
    turningOn ? ["pull", afterPrevious("tracks")] : ["close_tracks", afterPrevious("tracks/close")],
    ["renegotiate", afterPrevious("renegotiate")],
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
  const stages = chain("join", t0, [
    ["prepare", (previous) => find(events, previous, (event) => event.k === "ws_new")],
    ["sync_connect", (previous) => find(events, previous, (event) => event.k === "ws_open")],
    ["sync_welcome", frame("welcome")],
    ["sync_entered", frame("entered_ack")],
  ]);
  return {
    ...stages,
    "join.sfu_publications": sinceCall(t0, httpEnd(events, t0, "publications")),
    "join.sfu_tracks": sinceCall(t0, httpEnd(events, t0, "tracks")),
    "join.sfu_renegotiate": sinceCall(t0, httpEnd(events, t0, "renegotiate")),
    "join.ice_connected": sinceCall(
      t0,
      find(events, t0, (event) => event.k === "ice_connected"),
    ),
  };
}

/**
 * diagnosticsOf is the card's diagnostics block: n, p50 and p95 of every round trip and stage over the kept cycles.
 * It returns undefined when no cycle carries a trace, so a run without tracing writes a card without the block.
 * @param {{ trace?: { rtt: Record<string, number | null>, stages: Record<string, number | null> } }[]} cycles
 */
export function diagnosticsOf(cycles) {
  const traced = cycles.flatMap((cycle) => (cycle.trace ? [cycle.trace] : []));
  if (!traced.length) return undefined;
  const stat = (summary) => ({ n: summary.n, p50: summary.p50, p95: summary.p95 });
  const block = (samples, keys) => {
    const summary = summarize(samples);
    return Object.fromEntries(keys.filter((key) => summary[key]).map((key) => [key, stat(summary[key])]));
  };
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
  };
}
