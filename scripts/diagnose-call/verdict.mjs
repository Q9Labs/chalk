// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
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

/** Videos the viewer chose not to receive send nothing on purpose, so a quiet sample with any is not a fault. */
const hiddenByViewer = (row) => number(row, "recv_hidden_videos") > 0;

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

/** What went wrong, at which step of the media path, and on whose side. */
const cause = (text, stage, side) => ({ text, stage, side });
const PAUSE_SIDES = { viewer: "viewer", congestion: "network" };

/** The join step that failed first (the innermost one) and whose side owns it. */
const JOIN_STEP_SIDES = { acquire_initial_media: "client", access_initialize: "API", create_media_client: "SFU", start_media: "SFU", create_sync_client: "Sync", start_sync: "Sync", wait_for_sync_live: "Sync", confirm_entered: "Sync" };

/** The client report carries its events as a JSON string; a report that does not parse names no step. */
function reportEvents(report) {
  try {
    const events = JSON.parse(String(attr(report, "report") ?? "{}")).events;
    return Array.isArray(events) ? events : [];
  } catch {
    return [];
  }
}

/** A 4xx answer is logged as `http.request` with its status; `http.failure` is the 5xx and transport case. */
const failedRequest = (row) => row.event === "http.failure" || (row.event === "http.request" && number(row, "status") >= 400);

function joinCause(rows, report) {
  const failure = rows.find((row) => failedRequest(row) && ((row.journey && row.journey === report.journey) || (row.trace && row.trace === report.trace)));
  if (failure) return cause(`the API refused the request (${attr(failure, "error_code") ?? (number(failure, "status") ? `HTTP ${number(failure, "status")}` : "code not logged")})`, "access_initialize", "API");
  const step = reportEvents(report).find((event) => event.event === "space_join_span" && event.outcome === "failed" && event.step in JOIN_STEP_SIDES);
  if (step) return cause(`the join failed at ${step.step} (${step.code ?? "code not logged"}) after ${seconds(step.duration_ms ?? 0)} s`, step.step, JOIN_STEP_SIDES[step.step]);
  return cause("unknown: no failed API request shares the report's journey id and the report names no failed step", "joining", "unknown");
}

const SUBSCRIPTION_EVENTS = ["sfu.subscription.paused", "sfu.subscription.resumed", "sfu.subscription.started"];
const SUBSCRIPTION_KEY = ["publisher_id", "source", "media_kind", "mid"];

/** The latest pause that no later resume or start of the same subscription ended by the time the run ended. */
function openPause(events, run) {
  const last = new Map();
  for (const row of [...events].sort((a, b) => a.time - b.time)) {
    if (row.time <= run.to && SUBSCRIPTION_EVENTS.includes(row.event)) last.set(SUBSCRIPTION_KEY.map((name) => attr(row, name) ?? "").join("/"), row);
  }
  return [...last.values()]
    .filter((row) => row.event === "sfu.subscription.paused")
    .sort((a, b) => a.time - b.time)
    .at(-1);
}

function silenceCause(rows, run) {
  const events = nodeEvents(rows, run.connection);
  const replacement = rows.findLast((row) => row.event === "media.connection_replacement" && row.participant === run.participant && row.time <= run.to);
  const resumed = events.some((row) => row.time >= run.from && (row.event === "sfu.subscription.resumed" || row.event === "sfu.subscription.started"));
  const paused = openPause(events, run);
  if (paused) return cause(`the node paused the subscription (${attr(paused, "reason") ?? "reason not logged"}) and did not resume it`, "forwarding", PAUSE_SIDES[attr(paused, "reason")] ?? "SFU");
  const lost = events.findLast((row) => row.event === "sfu.source.lease_lost" && row.time <= run.to);
  if (lost) return cause(`the source lost its lease on the node (${attr(lost, "cause") ?? "cause not logged"})`, "publishing", "SFU");
  if (replacement && !resumed) return cause(`the connection was replaced (${attr(replacement, "replacement_cause") ?? "cause not logged"}) and the node logged no subscription starting on the new one`, "reconnecting", "API");
  if (events.length === 0) return cause("unknown: the SFU node logged no event for this connection", "unknown", "unknown");
  return cause("unknown: the node events for this connection do not explain it", "unknown", "unknown");
}

function starvedCause(rows, run) {
  const layer = nodeEvents(rows, run.connection).findLast((row) => row.event === "sfu.subscription.layer" && row.time <= run.to);
  if (!layer) return cause("unknown: the SFU node logged no layer for this connection", "unknown", "unknown");
  const [now, ceiling, limit] = ["layer", "ceiling", "server_limit"].map((name) => attr(layer, name) ?? "not logged");
  if (limit === "low" && ceiling !== "low") return cause(`the node held the viewer to the ${now} layer (server limit ${limit}, viewer ceiling ${ceiling})`, "forwarding", "SFU");
  if (ceiling === "low") return cause(`the viewer asked for the ${now} layer (ceiling ${ceiling})`, "receiving", "viewer");
  return cause(`the node and the viewer allowed more than the ${now} layer, so the publisher sent no better one (ceiling ${ceiling}, server limit ${limit})`, "publishing", "publisher");
}

function joinedAt(rows, participant) {
  const db = rows.find((row) => row.source === "db" && row.participant === participant);
  return db?.time ?? rows.find((row) => row.participant === participant)?.time;
}

/** Everything the thresholds call bad about the call, worst first, plus the evidence the rows lack. */
export function diagnose(rows, thresholds) {
  const samples = samplesOf(rows);
  const findings = [];
  const add = (kind, who, from, to, experience, why, benign = false) => findings.push({ kind, participant: who, from, to, experience, cause: why.text, stage: why.stage, side: why.side, benign });

  for (const report of rows.filter((row) => row.event === "sdk.connection_report" && attr(row, "trigger") === "join_failed")) {
    add("failed_join", report.participant, report.time, report.time, "could not join", joinCause(rows, report));
  }

  for (const run of runsOf(samples, (row) => number(row, "recv_bitrate_kbps") === 0 && !hiddenByViewer(row))) {
    // A receiver that has taken no media yet is still starting up, so only a start that fails to finish within the starved window counts.
    if (run.to - run.from <= (receivedBefore(samples, run) ? thresholds.silence_ms : thresholds.starved_ms) || !senderWasSending(samples, run)) continue;
    add("media_silence", run.participant, run.from, run.to, `received no media for ${seconds(run.to - run.from)} s while a sender was sending`, silenceCause(rows, run));
  }

  for (const run of runsOf(samples, (row) => number(row, "send_bitrate_kbps") === 0)) {
    if (run.to - run.from <= thresholds.silence_ms || !someoneElseReported(samples, run)) continue;
    add("publisher_silent", run.participant, run.from, run.to, `sent no media for ${seconds(run.to - run.from)} s while another Participant was in the call`, publishCause(rows, run));
  }

  const linkFault = (row) => {
    const loss = number(row, "recv_loss_pct") ?? 0;
    const rtt = number(row, "rtt_ms") ?? 0;
    const available = number(row, "available_incoming_kbps") ?? Infinity;
    return [loss > thresholds.healthy_loss_pct, rtt > thresholds.healthy_rtt_ms, available < 4 * thresholds.starved_floor_kbps];
  };
  const faulty = (row) => linkFault(row).some(Boolean);
  const worst = (run, name, pick) => pick(...run.samples.map((sample) => number(sample.row, name)).filter(Number.isFinite));
  const describeLink = (run) => {
    const [loss, rtt, available] = [0, 1, 2].map((at) => run.samples.some((sample) => linkFault(sample.row)[at]));
    return [loss && `${worst(run, "recv_loss_pct", Math.max)}% loss at worst`, rtt && `${worst(run, "rtt_ms", Math.max)} ms round trip at worst`, available && `${worst(run, "available_incoming_kbps", Math.min)} kbps available at best`].filter(Boolean).join(", ");
  };
  const lowVideo = (row) => attr(row, "recv_height") !== undefined && number(row, "recv_bitrate_kbps") > 0 && number(row, "recv_bitrate_kbps") < thresholds.starved_floor_kbps && !hiddenByViewer(row);
  const starved = (row) => lowVideo(row) && !faulty(row);
  for (const run of runsOf(samples, starved)) {
    if (run.to - run.from > thresholds.starved_ms) {
      const peak = Math.max(...run.samples.map((sample) => number(sample.row, "recv_bitrate_kbps")));
      add("starved_viewer", run.participant, run.from, run.to, `received video at ${peak} kbps or less for ${seconds(run.to - run.from)} s on a healthy link`, starvedCause(rows, run));
    }
  }
  for (const run of runsOf(samples, (row) => lowVideo(row) && faulty(row))) {
    if (run.to - run.from > thresholds.starved_ms) {
      const peak = Math.max(...run.samples.map((sample) => number(sample.row, "recv_bitrate_kbps")));
      add("congested_viewer", run.participant, run.from, run.to, `received video at ${peak} kbps or less for ${seconds(run.to - run.from)} s on a poor link`, cause(`the viewer's link was poor (${describeLink(run)})`, "receiving", "network"));
    }
  }

  for (const row of rows.filter((candidate) => candidate.event === "media.connection_replacement")) {
    const joined = joinedAt(rows, row.participant);
    if (joined !== undefined && row.time - joined <= thresholds.early_replacement_ms) {
      add("early_replacement", row.participant, joined, row.time, `had the media connection replaced ${seconds(row.time - joined)} s after joining`, cause(attr(row, "replacement_cause") ?? "cause not logged", "reconnecting", "API"));
    }
  }

  for (const run of runsOf(samples, (row) => hiddenByViewer(row) && number(row, "recv_bitrate_kbps") < thresholds.starved_floor_kbps)) {
    if (run.to - run.from > thresholds.silence_ms) {
      add("viewer_hid_video", run.participant, run.from, run.to, `hid its own video for ${seconds(run.to - run.from)} s, so little or no media arrived`, cause("the viewer's tile or page was hidden, which the SDK treats as a reason to stop receiving", "receiving", "viewer"), true);
    }
  }

  findings.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.from - b.from);
  return { findings, missing: missingEvidence(rows, samples) };
}

const KINDS = ["failed_join", "media_silence", "publisher_silent", "starved_viewer", "congested_viewer", "early_replacement", "viewer_hid_video"];

/** True when another Participant of the Episode reported stats while the run lasted, so there was someone to send to. */
function someoneElseReported(samples, run) {
  return samples.some((sample) => sample.participant !== run.participant && sample.end > run.from && sample.start < run.to);
}

function publishCause(rows, run) {
  const events = nodeEvents(rows, run.connection);
  const stopped = events.findLast((row) => row.event === "sfu.publication.stopped" && row.time <= run.to);
  if (stopped) return cause(`the node stopped the publication (${attr(stopped, "reason") ?? "reason not logged"}) and the client sent nothing after it`, "publishing", "SFU");
  if (events.some((row) => row.event === "sfu.publication.started")) return cause("the node accepted the publication and the client's sender then sent 0 kbps", "publishing", "publisher");
  if (events.length === 0) return cause("the client's sender sent 0 kbps; the SFU node logged no event for this connection, so the node's part is not proved", "publishing", "publisher");
  return cause("the node logged no publication for this connection, and the client's sender sent 0 kbps", "publishing", "publisher");
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

/** The one line a person reads: who, what they lived through, from when to when, the failing stage and side, and why. */
export function verdictLine(findings) {
  const first = findings.find((finding) => !finding.benign);
  const note = findings.find((finding) => finding.benign);
  if (!first) {
    const none = "No bad call found by the rules: no failed join, media silence, silent publisher, starved or congested viewer or early replacement";
    return note ? `${none}. Participant ${short(note.participant)} ${note.experience} (stage: ${note.stage}, side: ${note.side}, by choice).` : `${none}.`;
  }
  const window = first.from === first.to ? `at ${clock(first.from)}` : `from ${clock(first.from)} to ${clock(first.to)}`;
  return `Participant ${short(first.participant ?? "unknown")} ${first.experience} ${window} UTC; failing stage: ${first.stage}, side: ${first.side}; cause: ${first.cause}.`;
}
