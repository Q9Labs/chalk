// fallow-ignore-file complexity -- the rules branch on every kind of evidence; the media-quality tests cover each branch, which the CRAP estimate cannot see.
import { seconds } from "./call.mjs";
import { cause, finding } from "./finding.mjs";
import { attr, flag, number } from "./rows.mjs";

/** The node writes a track's counters every 10 s while they move. Two rows further apart had their counters standing still between them, so they are no interval. */
const MAX_GAP_MS = 35_000;
/** The three media events of one tick are written together, so rows of one tick are within this of each other. */
const SAME_TICK_MS = 2000;

const grouped = (rows, keyOf) => {
  const groups = new Map();
  for (const row of rows) groups.set(keyOf(row), [...(groups.get(keyOf(row)) ?? []), row]);
  return [...groups.values()];
};

const percent = (part, whole) => (whole > 0 ? (100 * part) / whole : 0);

/** How much a cumulative counter grew between two rows, or undefined when the rows do not carry it or it fell. */
function growth(a, b, name) {
  const before = number(a, name);
  const after = number(b, name);
  return before === undefined || after === undefined || after < before ? undefined : after - before;
}

/**
 * Consecutive rows of one track or session as intervals. `build` reads the counters of both rows. A pair further apart than the export
 * cadence is skipped, because the counters stood still between them.
 */
function intervalsOf(rows, build) {
  const intervals = [];
  for (let at = 1; at < rows.length; at += 1) {
    const [a, b] = [rows[at - 1], rows[at]];
    if (b.time > a.time && b.time - a.time <= MAX_GAP_MS) intervals.push({ from: a.time, to: b.time, ...build(a, b) });
  }
  return intervals;
}

/**
 * One interval of a publisher's track at the node. `lost` counts packets still missing, so a late repair lowers it: the packets that
 * did not arrive first time are what it grew plus what was repaired, and the packets still missing are what it grew, never below zero.
 * A packet counter that fell means the track was recreated, and that interval says nothing about loss.
 */
function ingressInterval(a, b) {
  const packets = growth(a, b, "packets");
  const reset = packets === undefined;
  const lostBy = (number(b, "lost") ?? 0) - (number(a, "lost") ?? 0);
  const repaired = Math.max(0, (number(b, "repaired") ?? 0) - (number(a, "repaired") ?? 0));
  const missing = Math.max(0, lostBy + repaired);
  const unrepaired = Math.max(0, lostBy);
  return {
    rows: [a, b],
    reset,
    held: flag(b, "held") === true || flag(a, "held") === true,
    missingPct: reset ? undefined : percent(missing, packets + missing),
    unrepairedPct: reset ? undefined : percent(unrepaired, packets + unrepaired),
    jitter: number(b, "jitter_ms"),
    bitrate: number(b, "bitrate_bps"),
    layersActive: number(b, "layers_active"),
    layers: number(b, "layers"),
  };
}

/**
 * One interval of what a subscriber's session receives, from its own reports. An egress total falls when the subscriber closes a track,
 * so the totals are not read; the loss share, round trip and jitter are the subscriber's current figures. The node's own drops for the
 * session come from the transport row of the same tick.
 */
function egressInterval(a, b, transport) {
  const tick = (time) => transport.find((row) => Math.abs(row.time - time) <= SAME_TICK_MS);
  const [before, after] = [tick(a.time), tick(b.time)];
  return {
    rows: [a, b, ...(after ? [after] : [])],
    lossPct: 100 * (number(b, "loss_share") ?? 0),
    jitter: number(b, "jitter_ms"),
    rtt: number(b, "rtt_ms"),
    bitrate: number(b, "bitrate_bps"),
    high: number(b, "high_layer"),
    low: number(b, "low_layer"),
    paused: number(b, "paused_subscriptions"),
    transport: after !== undefined && before !== undefined,
    dropped: before && after ? growth(before, after, "dropped") : undefined,
    repairsCut: before && after ? growth(before, after, "repairs_cut") : undefined,
    estimateBps: after ? number(after, "estimate_bps") : undefined,
    queuedBytes: after ? number(after, "queued_bytes") : undefined,
    feedbackAgeMs: after ? number(after, "feedback_age_ms") : undefined,
  };
}

const cache = new WeakMap();

/**
 * What the node measured of every track and session of the call, in one shape for the rules and the timeline: each publisher's
 * tracks (the uplink), each subscriber's downlink by media kind, and each session's send side. Rows are in time order.
 */
export function mediaOf(call) {
  if (!cache.has(call)) {
    const rowsOf = (event) => call.rows.filter((row) => row.source === "sfu" && row.connection && row.event === event);
    const transport = grouped(rowsOf("sfu.media.transport"), (row) => row.connection);
    const transportOf = (connection) => transport.find((rows) => rows[0].connection === connection) ?? [];
    const named = (rows, extra) => ({ connection: rows[0].connection, participant: rows[0].participant, rows, ...extra });
    cache.set(call, {
      ingress: grouped(rowsOf("sfu.media.ingress"), (row) => `${row.connection}/${attr(row, "mid")}`).map((rows) => named(rows, { source: attr(rows[0], "source"), kind: attr(rows[0], "media_kind"), intervals: intervalsOf(rows, ingressInterval) })),
      egress: grouped(rowsOf("sfu.media.egress"), (row) => `${row.connection}/${attr(row, "media_kind")}`).map((rows) => named(rows, { kind: attr(rows[0], "media_kind"), intervals: intervalsOf(rows, (a, b) => egressInterval(a, b, transportOf(rows[0].connection))) })),
      transport: transport.map((rows) => named(rows, {})),
    });
  }
  return cache.get(call);
}

/** Runs of consecutive intervals for which `bad` holds. A gap in the export, or an interval that says nothing, ends a run. */
function runsOf(intervals, bad) {
  const runs = [];
  let run;
  for (const interval of intervals) {
    if (!bad(interval)) {
      run = undefined;
    } else if (run && interval.from <= run.to + SAME_TICK_MS) {
      run.to = interval.to;
      run.intervals.push(interval);
    } else {
      run = { from: interval.from, to: interval.to, intervals: [interval] };
      runs.push(run);
    }
  }
  return runs;
}

const worst = (intervals, name, pick = Math.max) => {
  const values = intervals.map((interval) => interval[name]).filter(Number.isFinite);
  return values.length === 0 ? undefined : pick(...values);
};
/** The middle value of the numbers in a list, or undefined when it holds none. */
export function middle(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length === 0 ? undefined : sorted[Math.floor(sorted.length / 2)];
}
const median = (intervals, name) => middle(intervals.map((interval) => interval[name]));
const rowsOfRun = (run) => run.intervals.flatMap((interval) => interval.rows);
const one = (value, digits = 1) => Number(value.toFixed(digits));
const kbps = (bps) => Math.round(bps / 1000);

const uplinkBad = (interval, thresholds) => !interval.reset && !interval.held && (interval.missingPct > thresholds.healthy_loss_pct || interval.jitter > thresholds.healthy_jitter_ms);
/** The node's own pacer dropped video for the session in this interval. */
const nodeBad = (interval) => interval.dropped > 0;
/** The subscriber's own reports show a poor link and the node dropped nothing, or its transport row is missing. */
const downlinkBad = (interval, thresholds) => !nodeBad(interval) && (interval.lossPct > thresholds.healthy_loss_pct || interval.rtt > thresholds.healthy_rtt_ms || interval.jitter > thresholds.healthy_jitter_ms);

function uplinkFindings(call, thresholds) {
  return mediaOf(call).ingress.flatMap((track) =>
    runsOf(track.intervals, (interval) => uplinkBad(interval, thresholds))
      .filter((run) => run.to - run.from >= thresholds.quality_ms)
      .map((run) => {
        const missing = worst(run.intervals, "missingPct");
        const left = worst(run.intervals, "unrepairedPct");
        const jitter = worst(run.intervals, "jitter");
        const rate = median(run.intervals, "bitrate");
        const text = `the publisher's uplink: ${one(missing)}% of packets did not arrive first time (${one(left)}% still missing after repair), jitter ${jitter === undefined ? "not logged" : `${one(jitter)} ms`} at worst${rate === undefined ? "" : `, ${kbps(rate)} kbps at median`}; every subscriber receives what is left. The node's own receive drops are not in these rows`;
        const what = [track.source, track.kind].filter(Boolean).join(" ") || "media";
        return finding("uplink_degraded", track.participant, run.from, run.to, `sent ${what} that reached the node degraded for ${seconds(run.to - run.from)} s`, cause(text, "publishing", "client"), rowsOfRun(run));
      }),
  );
}

const maybe = (label, value, unit) => (value === undefined ? undefined : `${label} ${one(value)}${unit} at worst`);

/** One line for the timeline: what the node measured of one published track over the call, healthy or not. */
export function trackSummary(track) {
  const rate = median(track.intervals, "bitrate");
  const last = track.rows.at(-1);
  const layers = number(last, "layers");
  return [
    `the node received ${[track.source, track.kind].filter(Boolean).join(" ") || "media"} from this Participant (${track.rows.length} stats rows)`,
    rate === undefined ? undefined : `${kbps(rate)} kbps at median`,
    maybe("first-arrival loss", worst(track.intervals, "missingPct"), "%"),
    maybe("still missing after repair", worst(track.intervals, "unrepairedPct"), "%"),
    maybe("jitter", worst(track.intervals, "jitter"), " ms"),
    layers === undefined ? undefined : `${number(last, "layers_active") ?? "?"} of ${layers} layers active at the end`,
  ]
    .filter(Boolean)
    .join("; ");
}

/** One line for the timeline: what the node sent a Participant of one media kind and what their own reports said of it. */
export function streamSummary(stream) {
  const rate = median(stream.intervals, "bitrate");
  const low = stream.intervals.filter((interval) => interval.low > 0).length;
  const estimate = worst(stream.intervals, "estimateBps", Math.min);
  const dropped = stream.intervals.reduce((total, interval) => total + (interval.dropped ?? 0), 0);
  return [
    `the node sent ${stream.kind} to this Participant (${stream.rows.length} stats rows)`,
    rate === undefined ? undefined : `${kbps(rate)} kbps at median`,
    maybe("loss", worst(stream.intervals, "lossPct"), "%"),
    maybe("round trip", worst(stream.intervals, "rtt"), " ms"),
    maybe("jitter", worst(stream.intervals, "jitter"), " ms"),
    stream.kind === "video" && stream.intervals.length > 0 ? `forwarded the low layer in ${low} of ${stream.intervals.length} samples` : undefined,
    estimate === undefined ? undefined : `node bandwidth estimate ${kbps(estimate)} kbps at lowest`,
    `the node's pacer dropped ${dropped} packets`,
  ]
    .filter(Boolean)
    .join("; ");
}

/** What the node knew of a subscriber's bandwidth and queue in a run, as a clause. */
function transportClause(run) {
  const estimate = worst(run.intervals, "estimateBps", Math.min);
  const queued = worst(run.intervals, "queuedBytes");
  const age = worst(run.intervals, "feedbackAgeMs");
  return [estimate !== undefined && `the node's bandwidth estimate was ${kbps(estimate)} kbps at lowest`, queued !== undefined && `its send queue held ${queued} bytes at most`, age !== undefined && `feedback was ${one(age / 1000)} s old at worst`].filter(Boolean).join(", ");
}

/** The cause text of a run of bad downlink intervals of one session: whether the node dropped the packets or the subscriber's link lost them. */
function downlinkCause(run) {
  const dropped = run.intervals.reduce((total, interval) => total + (interval.dropped ?? 0), 0);
  const loss = worst(run.intervals, "lossPct");
  const rtt = worst(run.intervals, "rtt");
  const link = `${loss === undefined ? "loss not logged" : `${one(loss)}% loss`}${rtt === undefined ? "" : `, ${one(rtt)} ms round trip`} in the subscriber's own reports`;
  const clause = transportClause(run);
  const layer = run.intervals.some((interval) => interval.low > 0) ? "; the node forwarded the low layer" : "";
  if (dropped > 0) return cause(`the node's own pacer dropped ${dropped} video packets for this subscriber because its send queue was full (${link}${clause ? `; ${clause}` : ""})${layer}`, "forwarding", "SFU");
  const measured = run.intervals.every((interval) => interval.transport);
  if (!measured) return cause(`the subscriber's own reports show ${link}; the node's transport rows for it are missing, so the node's own drops are not ruled out and the rows do not say whether the node or the downlink lost the packets`, "receiving", "unknown");
  return cause(`the subscriber's downlink: ${link}; the node dropped nothing for it in that time${clause ? ` (${clause})` : ""}, so the packets were lost on the way to the subscriber${layer}`, "receiving", "client");
}

function downlinkFindings(call, thresholds) {
  const found = [];
  for (const stream of mediaOf(call).egress) {
    for (const run of runsOf(stream.intervals, nodeBad).filter((candidate) => candidate.to - candidate.from >= thresholds.quality_ms)) {
      found.push(finding("node_dropping", stream.participant, run.from, run.to, `received ${stream.kind} that the node dropped for ${seconds(run.to - run.from)} s`, downlinkCause(run), rowsOfRun(run)));
    }
    for (const run of runsOf(stream.intervals, (interval) => downlinkBad(interval, thresholds)).filter((candidate) => candidate.to - candidate.from >= thresholds.quality_ms)) {
      const why = downlinkCause(run);
      found.push(finding("downlink_degraded", stream.participant, run.from, run.to, `received ${stream.kind} over a lossy downlink for ${seconds(run.to - run.from)} s`, why, rowsOfRun(run)));
    }
  }
  return found;
}

/** What the node measured about the publishers, the subscribers and the node itself, as findings: each names the leg that lost the packets. */
export function qualityFindings(call, thresholds) {
  return [...uplinkFindings(call, thresholds), ...downlinkFindings(call, thresholds)];
}

/** Intervals of one connection's downlink that overlap [from, to]. */
const overlapping = (call, connection, from, to) =>
  mediaOf(call)
    .egress.filter((stream) => stream.connection === connection)
    .map((stream) => ({ ...stream, intervals: stream.intervals.filter((interval) => interval.to > from && interval.from < to) }))
    .filter((stream) => stream.intervals.length > 0);

/**
 * The node's account of why a viewer's video was starved, from its own rows for the viewer's connection: its pacer dropped packets,
 * or the viewer's reports show a poor link. Undefined when the node logged nothing for the viewer or logged a clean link.
 */
export function viewerLinkCause(call, run, thresholds) {
  const streams = overlapping(call, run.connection, run.from, run.to);
  const intervals = streams.flatMap((stream) => stream.intervals);
  const bad = intervals.filter((interval) => nodeBad(interval) || downlinkBad(interval, thresholds));
  if (bad.length === 0) return undefined;
  const why = downlinkCause({ intervals: bad });
  return { why, rows: bad.flatMap((interval) => interval.rows).slice(-4) };
}

/** True when the node logged downlink rows for the viewer in the run and none of them showed loss, drops or a long round trip. */
export function viewerLinkClean(call, run, thresholds) {
  const intervals = overlapping(call, run.connection, run.from, run.to).flatMap((stream) => stream.intervals);
  return intervals.length > 0 && !intervals.some((interval) => nodeBad(interval) || downlinkBad(interval, thresholds));
}

/** The node's account of a publisher's uplink during a run: undefined when the node logged no ingress for the senders or they were clean. */
export function senderUplinkCause(call, run, senders, thresholds) {
  const tracks = mediaOf(call).ingress.filter((track) => senders.has(track.participant));
  for (const track of tracks) {
    const bad = runsOf(
      track.intervals.filter((interval) => interval.to > run.from && interval.from < run.to),
      (interval) => uplinkBad(interval, thresholds),
    );
    if (bad.length === 0) continue;
    const intervals = bad.flatMap((candidate) => candidate.intervals);
    const missing = worst(intervals, "missingPct");
    const jitter = worst(intervals, "jitter");
    const text = `the publisher's uplink was bad at the node (${one(missing ?? 0)}% of packets missing first time${jitter === undefined ? "" : `, jitter ${one(jitter)} ms`}), so the viewer received what was left`;
    return { why: cause(text, "publishing", "client"), rows: intervals.flatMap((interval) => interval.rows).slice(-4) };
  }
  return undefined;
}
