import { attr } from "./rows.mjs";

const clock = (ms) => new Date(ms).toISOString().slice(11, 19);
const seconds = (ms) => Math.round(ms / 1000);
const short = (participant) => participant.slice(0, 8);

/**
 * The call_stats row's time is when the upload arrived and one upload carries several samples, so a sample's own
 * time is the connection's media start plus `elapsed_ms`. The start is the earliest `time - elapsed_ms` of the connection.
 */
function samplesOf(rows) {
  const stats = rows.filter((row) => row.event === "sdk.call_stats" && row.connection);
  const origin = new Map();
  for (const row of stats) {
    const start = row.time - Number(attr(row, "elapsed_ms") ?? 0);
    origin.set(row.connection, Math.min(origin.get(row.connection) ?? Infinity, start));
  }
  return stats
    .map((row) => {
      const end = origin.get(row.connection) + Number(attr(row, "elapsed_ms") ?? 0);
      return { row, participant: row.participant, connection: row.connection, end, start: end - Number(attr(row, "window_ms") ?? 0) };
    })
    .sort((a, b) => a.start - b.start);
}

/** Joins samples of one connection that follow each other into runs for which `match` holds. */
function runsOf(samples, match) {
  const runs = [];
  for (const connection of new Set(samples.map((sample) => sample.connection))) {
    let run;
    for (const sample of samples.filter((candidate) => candidate.connection === connection)) {
      if (!match(sample.row)) {
        run = undefined;
      } else if (run && sample.start <= run.to + 2000) {
        run.to = sample.end;
        run.samples.push(sample);
      } else {
        run = { participant: sample.participant, connection, from: sample.start, to: sample.end, samples: [sample] };
        runs.push(run);
      }
    }
  }
  return runs;
}

const number = (row, name) => {
  const value = attr(row, name);
  return value === undefined ? undefined : Number(value);
};

function senderWasSending(samples, run) {
  return samples.some((sample) => sample.participant !== run.participant && sample.end > run.from && sample.start < run.to && number(sample.row, "send_bitrate_kbps") > 0);
}

/** True when the Participant took media on any connection before the run, so the run is a stop and not a connection that never carried media. */
function receivedBefore(samples, run) {
  return samples.some((sample) => sample.participant === run.participant && sample.end <= run.from && number(sample.row, "recv_bitrate_kbps") > 0);
}

function nodeEvents(rows, connection) {
  return rows.filter((row) => row.source === "sfu" && row.connection === connection);
}

function silenceCause(rows, run) {
  const events = nodeEvents(rows, run.connection);
  const replacement = rows.findLast((row) => row.event === "media.connection_replacement" && row.participant === run.participant && row.time <= run.to);
  const resumed = events.some((row) => row.time >= run.from && (row.event === "sfu.subscription.resumed" || row.event === "sfu.subscription.started"));
  const paused = events.findLast((row) => row.event === "sfu.subscription.paused" && row.time <= run.to);
  if (paused && !resumed) return `the node paused the subscription (${attr(paused, "reason") ?? "reason not logged"}) and did not resume it`;
  const lost = events.findLast((row) => row.event === "sfu.source.lease_lost" && row.time <= run.to);
  if (lost) return `the source lost its lease on the node (${attr(lost, "cause") ?? "cause not logged"})`;
  if (replacement && !resumed) return `the connection was replaced (${attr(replacement, "replacement_cause") ?? "cause not logged"}) and the node logged no subscription starting on the new one`;
  if (events.length === 0) return "unknown: the SFU node logged no event for this connection";
  return "unknown: the node events for this connection do not explain it";
}

function starvedCause(rows, run) {
  const layer = nodeEvents(rows, run.connection).findLast((row) => row.event === "sfu.subscription.layer" && row.time <= run.to);
  if (!layer) return "unknown: the SFU node logged no layer for this connection";
  const [now, ceiling, limit] = ["layer", "ceiling", "server_limit"].map((name) => attr(layer, name) ?? "not logged");
  if (limit === "low" && ceiling !== "low") return `the node held the viewer to the ${now} layer (server limit ${limit}, viewer ceiling ${ceiling})`;
  if (ceiling === "low") return `the viewer asked for the ${now} layer (ceiling ${ceiling})`;
  return `the node and the viewer allowed more than the ${now} layer, so the publisher sent no better one (ceiling ${ceiling}, server limit ${limit})`;
}

function joinedAt(rows, participant) {
  const db = rows.find((row) => row.source === "db" && row.participant === participant);
  return db?.time ?? rows.find((row) => row.participant === participant)?.time;
}

/** Everything the thresholds call bad about the call, worst first, plus the evidence the rows lack. */
export function diagnose(rows, thresholds) {
  const samples = samplesOf(rows);
  const findings = [];

  for (const report of rows.filter((row) => row.event === "sdk.connection_report" && attr(row, "trigger") === "join_failed")) {
    const failure = rows.find((row) => row.event === "http.failure" && row.journey && row.journey === report.journey);
    const code = failure ? attr(failure, "error_code") : undefined;
    findings.push({
      kind: "failed_join",
      participant: report.participant,
      from: report.time,
      to: report.time,
      experience: "could not join",
      cause: code ? `the API refused the request (${code})` : "unknown: no failed API request shares the report's journey id",
    });
  }

  for (const run of runsOf(samples, (row) => number(row, "recv_bitrate_kbps") === 0)) {
    if (run.to - run.from <= thresholds.silence_ms) continue;
    if (!senderWasSending(samples, run) || !receivedBefore(samples, run)) continue;
    findings.push({
      kind: "media_silence",
      participant: run.participant,
      from: run.from,
      to: run.to,
      experience: `received no media for ${seconds(run.to - run.from)} s while a sender was sending`,
      cause: silenceCause(rows, run),
    });
  }

  const healthy = (row) => (number(row, "recv_loss_pct") ?? 0) <= thresholds.healthy_loss_pct && (number(row, "rtt_ms") ?? 0) <= thresholds.healthy_rtt_ms && (number(row, "available_incoming_kbps") ?? Infinity) >= 4 * thresholds.starved_floor_kbps;
  const starved = (row) => attr(row, "recv_height") !== undefined && number(row, "recv_bitrate_kbps") > 0 && number(row, "recv_bitrate_kbps") < thresholds.starved_floor_kbps && healthy(row);
  for (const run of runsOf(samples, starved)) {
    if (run.to - run.from > thresholds.starved_ms) {
      const peak = Math.max(...run.samples.map((sample) => number(sample.row, "recv_bitrate_kbps")));
      findings.push({ kind: "starved_viewer", participant: run.participant, from: run.from, to: run.to, experience: `received video at ${peak} kbps or less for ${seconds(run.to - run.from)} s on a healthy link`, cause: starvedCause(rows, run) });
    }
  }

  for (const row of rows.filter((candidate) => candidate.event === "media.connection_replacement")) {
    const joined = joinedAt(rows, row.participant);
    if (joined !== undefined && row.time - joined <= thresholds.early_replacement_ms) {
      findings.push({ kind: "early_replacement", participant: row.participant, from: joined, to: row.time, experience: `had the media connection replaced ${seconds(row.time - joined)} s after joining`, cause: `${attr(row, "replacement_cause") ?? "cause not logged"}` });
    }
  }

  const order = ["failed_join", "media_silence", "starved_viewer", "early_replacement"];
  findings.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.from - b.from);
  return { findings, missing: missingEvidence(rows, samples) };
}

function missingEvidence(rows, samples) {
  const missing = [];
  for (const source of ["client", "api", "sync", "sfu", "db"]) {
    if (!rows.some((row) => row.source === source)) missing.push(`no ${source} rows reached the Episode by id`);
  }
  const reporting = new Set(samples.map((sample) => sample.participant));
  for (const participant of new Set(rows.filter((row) => row.source === "db").map((row) => row.participant))) {
    if (!reporting.has(participant)) missing.push(`Participant ${short(participant)} has no sdk.call_stats rows`);
  }
  for (const participant of reporting) {
    const own = samples.filter((sample) => sample.participant === participant);
    if (!own.some((sample) => attr(sample.row, "recv_bitrate_kbps") !== undefined)) missing.push(`Participant ${short(participant)} has no inbound rows in sdk.call_stats`);
    if (!own.some((sample) => attr(sample.row, "send_bitrate_kbps") !== undefined)) missing.push(`Participant ${short(participant)} has no send bitrate in sdk.call_stats`);
  }
  return missing;
}

/** The one line a person reads: who, what they lived through, from when to when, and why. */
export function verdictLine(findings) {
  const [first] = findings;
  if (!first) return "No bad call found by the rules: no failed join, media silence, starved viewer or early replacement.";
  const window = first.from === first.to ? `at ${clock(first.from)}` : `from ${clock(first.from)} to ${clock(first.to)}`;
  return `Participant ${short(first.participant ?? "unknown")} ${first.experience} ${window} UTC; cause: ${first.cause}.`;
}
