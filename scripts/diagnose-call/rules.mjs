// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
import { hiddenByViewer, runsOf, seconds, short } from "./call.mjs";
import { cause, finding } from "./finding.mjs";
import { clientReports } from "./reports.mjs";
import { attr, number, participantHash } from "./rows.mjs";
import { sessions } from "./sessions.mjs";

/** Participants other than `run`'s whose samples overlap it with a sender above zero. */
function sendersDuring(call, run) {
  return new Set(call.samples.filter((sample) => sample.participant !== run.participant && sample.end > run.from && sample.start < run.to && number(sample.row, "send_bitrate_kbps") > 0).map((sample) => sample.participant));
}

/** True when the Participant took media on any connection before the run, so the run is a stop and not a connection that never carried media. */
function receivedBefore(call, run) {
  return call.samples.some((sample) => sample.participant === run.participant && sample.end <= run.from && number(sample.row, "recv_bitrate_kbps") > 0);
}

const SUBSCRIPTION_EVENTS = ["sfu.subscription.paused", "sfu.subscription.resumed", "sfu.subscription.started", "sfu.subscription.stopped"];
const SUBSCRIPTION_KEY = ["publisher_id", "source", "media_kind", "mid"];
const PAUSE_SIDES = { viewer: "client", congestion: "client" };

/** True when a subscription event names a publisher who is not among `senders`: another Participant's media, not what the viewer waited for. */
const foreignPublisher = (row, senders) => attr(row, "publisher_id") !== undefined && !senders.has(participantHash(String(attr(row, "publisher_id"))));

/** The latest pause that no later resume, start or stop of the same subscription ended by the time the run ended. */
function openPause(events, run, senders) {
  const last = new Map();
  for (const row of [...events].sort((a, b) => a.time - b.time)) {
    if (row.time <= run.to && SUBSCRIPTION_EVENTS.includes(row.event) && !foreignPublisher(row, senders)) last.set(SUBSCRIPTION_KEY.map((name) => attr(row, name) ?? "").join("/"), row);
  }
  return [...last.values()]
    .filter((row) => row.event === "sfu.subscription.paused")
    .sort((a, b) => a.time - b.time)
    .at(-1);
}

/**
 * A source lease the node lost inside the run, on a publisher the viewer waited for, and not as that publisher left: a lease revoked
 * as its owner leaves is normal cleanup, so only a loss before the departure counts.
 */
function lostLease(call, run, senders, thresholds) {
  return call.rows.findLast((row) => {
    if (row.event !== "sfu.source.lease_lost" || !senders.has(row.participant) || row.time < run.from - thresholds.leave_slack_ms || row.time > run.to) return false;
    const departed = call.departedAt(row.participant);
    return departed === undefined || row.time < departed - thresholds.leave_slack_ms;
  });
}

function silenceCause(call, run, thresholds) {
  const events = call.nodeEvents(run.connection);
  const senders = sendersDuring(call, run);
  const replacement = call.rows.findLast((row) => row.event === "media.connection_replacement" && row.participant === run.participant && row.time >= run.from - thresholds.leave_slack_ms && row.time <= run.to);
  const resumed = events.some((row) => row.time >= run.from && (row.event === "sfu.subscription.resumed" || row.event === "sfu.subscription.started"));
  const paused = openPause(events, run, senders);
  if (paused) return { why: cause(`the node paused the subscription (${attr(paused, "reason") ?? "reason not logged"}) and did not resume it`, "forwarding", PAUSE_SIDES[attr(paused, "reason")] ?? "SFU"), rows: [paused] };
  const lost = lostLease(call, run, senders, thresholds);
  if (lost) return { why: cause(`the publisher's ${attr(lost, "source") ?? "source"} lease was lost on the node (${attr(lost, "cause") ?? "cause not logged"}) while the Participant was still in the call`, "publishing", attr(lost, "cause") === "revoked" ? "Sync" : "SFU"), rows: [lost] };
  if (replacement && !resumed) return { why: cause(`the connection was replaced (${attr(replacement, "replacement_cause") ?? "cause not logged"}) and the node logged no subscription starting on the new one`, "reconnecting", "API"), rows: [replacement] };
  if (events.length === 0) return { why: cause("unknown: the SFU node logged no event for this connection", "unknown", "unknown"), rows: [] };
  return { why: cause("unknown: the node events for this connection do not explain it", "unknown", "unknown"), rows: [] };
}

function mediaSilence(call, thresholds) {
  const found = [];
  for (const run of runsOf(call.samples, (row) => number(row, "recv_bitrate_kbps") === 0 && !hiddenByViewer(row))) {
    // A receiver that has taken no media yet is still starting up, so only a start that fails to finish within the starved window counts.
    if (run.to - run.from <= (receivedBefore(call, run) ? thresholds.silence_ms : thresholds.starved_ms) || sendersDuring(call, run).size === 0) continue;
    const { why, rows } = silenceCause(call, run, thresholds);
    found.push(finding("media_silence", run.participant, run.from, run.to, `received no media for ${seconds(run.to - run.from)} s while a sender was sending`, why, [...run.samples.map((sample) => sample.row), ...rows]));
  }
  return found;
}

function publisherSilent(call, thresholds) {
  const found = [];
  for (const run of runsOf(call.samples, (row) => number(row, "send_bitrate_kbps") === 0)) {
    const someoneElse = call.samples.some((sample) => sample.participant !== run.participant && sample.end > run.from && sample.start < run.to);
    if (run.to - run.from <= thresholds.silence_ms || !someoneElse) continue;
    const events = call.nodeEvents(run.connection);
    const stopped = events.findLast((row) => row.event === "sfu.publication.stopped" && row.time <= run.to);
    const why = stopped
      ? cause(`the node stopped the publication (${attr(stopped, "reason") ?? "reason not logged"}) and the client sent nothing after it`, "publishing", "SFU")
      : events.some((row) => row.event === "sfu.publication.started")
        ? cause("the node accepted the publication and the client's sender then sent 0 kbps", "publishing", "client")
        : events.length === 0
          ? cause("the client's sender sent 0 kbps; the SFU node logged no event for this connection, so the node's part is not proved", "publishing", "client")
          : cause("the node logged no publication for this connection, and the client's sender sent 0 kbps", "publishing", "client");
    found.push(finding("publisher_silent", run.participant, run.from, run.to, `sent no media for ${seconds(run.to - run.from)} s while another Participant was in the call`, why, [...run.samples.map((sample) => sample.row), ...(stopped ? [stopped] : [])]));
  }
  return found;
}

/** Loss, round trip and, when the client measured it, the downlink the browser estimated. An absent estimate is not a clear link. */
function linkFaults(row, thresholds) {
  const available = number(row, "available_incoming_kbps");
  return { loss: number(row, "recv_loss_pct") > thresholds.healthy_loss_pct, rtt: number(row, "rtt_ms") > thresholds.healthy_rtt_ms, bandwidth: available !== undefined && available < thresholds.available_floor_kbps };
}

const lowVideo = (row, thresholds) => attr(row, "recv_height") !== undefined && number(row, "recv_bitrate_kbps") > 0 && number(row, "recv_bitrate_kbps") < thresholds.starved_floor_kbps && !hiddenByViewer(row);
const faulty = (row, thresholds) => Object.values(linkFaults(row, thresholds)).some(Boolean);

function describeLink(run, thresholds) {
  const worst = (name, pick) => pick(...run.samples.map((sample) => number(sample.row, name)).filter(Number.isFinite));
  const seen = (name) => run.samples.some((sample) => linkFaults(sample.row, thresholds)[name]);
  return [seen("loss") && `${worst("recv_loss_pct", Math.max)}% loss at worst`, seen("rtt") && `${worst("rtt_ms", Math.max)} ms round trip at worst`, seen("bandwidth") && `${worst("available_incoming_kbps", Math.min)} kbps available at best`].filter(Boolean).join(", ");
}

/** What the senders sent while the run lasted: the best sender's median bitrate and layer, which tells a starved viewer from a starved publisher. */
function senderDuring(call, run) {
  const sent = call.samples.filter((sample) => sample.participant !== run.participant && sample.end > run.from && sample.start < run.to && number(sample.row, "send_bitrate_kbps") !== undefined);
  const best = [...new Set(sent.map((sample) => sample.participant))]
    .map((participant) => {
      const own = sent.filter((sample) => sample.participant === participant);
      const rates = own.map((sample) => number(sample.row, "send_bitrate_kbps")).sort((a, b) => a - b);
      return { participant, kbps: rates[Math.floor(rates.length / 2)], layer: attr(own.at(-1).row, "send_layer"), rows: [own[0].row, own.at(-1).row] };
    })
    .sort((a, b) => b.kbps - a.kbps)[0];
  return best;
}

const CONGESTION_WINDOW_MS = 60_000;

/** The node's bandwidth estimate for the viewer, when it logged one in or just before the run. */
function estimateCause(events, run, sending) {
  const congestion = events.findLast((row) => row.event === "sfu.subscription.congestion" && row.time <= run.to && row.time >= run.from - CONGESTION_WINDOW_MS);
  if (!congestion) return undefined;
  const estimate = number(congestion, "estimate_bps");
  const delivered = number(congestion, "delivered_share");
  const lost = number(congestion, "loss_share");
  const detail = [estimate !== undefined && `estimate ${Math.round(estimate / 1000)} kbps`, attr(congestion, "reason") && `reason ${attr(congestion, "reason")}`, delivered !== undefined && `${Math.round(delivered * 100)}% delivered`, lost !== undefined && `${Math.round(lost * 100)}% loss`]
    .filter(Boolean)
    .join(", ");
  return { why: cause(`the node's bandwidth estimate for the viewer held the video down (${detail}); ${sending}`, "forwarding", "SFU"), rows: [congestion] };
}

function pausedCause(events, run, senders, sending) {
  const paused = openPause(events, run, senders);
  return paused && { why: cause(`the node paused the subscription (${attr(paused, "reason") ?? "reason not logged"}); ${sending}`, "forwarding", PAUSE_SIDES[attr(paused, "reason")] ?? "SFU"), rows: [paused] };
}

function layerCause(events, run, sending) {
  const layer = events.findLast((row) => row.event === "sfu.subscription.layer" && attr(row, "media_kind") !== "audio" && row.time <= run.to);
  if (!layer) return undefined;
  const held = attr(layer, "layer") !== "high";
  return { why: cause(`the node forwarded layer ${attr(layer, "layer")}${held ? ", below the highest" : ""}; ${sending}`, "forwarding", held ? "SFU" : "unknown"), rows: [layer] };
}

/** The node's own account of why a viewer's video was held down: its bandwidth estimate, then a pause, then a weak publisher, then the layer it forwarded. */
function starvedCause(call, run, thresholds) {
  const events = call.nodeEvents(run.connection);
  const sender = senderDuring(call, run);
  const sending = sender ? `${short(sender.participant)} was sending ${sender.kbps} kbps${sender.layer ? ` at layer ${sender.layer}` : ""} meanwhile` : "no sender's bitrate was logged";
  const named = estimateCause(events, run, sending) ?? pausedCause(events, run, sendersDuring(call, run), sending);
  if (named) return { ...named, rows: [...named.rows, ...(sender?.rows ?? [])] };
  if (sender && sender.kbps < thresholds.starved_floor_kbps) return { why: cause(`the publisher itself sent only ${sender.kbps} kbps`, "publishing", "client"), rows: sender.rows };
  const layer = layerCause(events, run, sending);
  if (layer) return { ...layer, rows: [...layer.rows, ...(sender?.rows ?? [])] };
  const nothing = events.length === 0 ? "the SFU node logged no event for this connection" : "the node events for this connection name no layer, pause or bandwidth estimate";
  return { why: cause(`unknown: ${nothing}; ${sending}, so the loss is on the way from the node to the viewer, either the node or the viewer's downlink`, "forwarding", "unknown"), rows: sender?.rows ?? [] };
}

/** Video that arrived at a trickle: on a measured-clear link it is starvation, on a faulty link it is the viewer's network. */
function lowBitrate(call, thresholds) {
  const found = [];
  const peak = (run) => Math.max(...run.samples.map((sample) => number(sample.row, "recv_bitrate_kbps")));
  const rowsOf = (run) => run.samples.map((sample) => sample.row);
  for (const run of runsOf(call.samples, (row) => lowVideo(row, thresholds) && !faulty(row, thresholds))) {
    if (run.to - run.from <= thresholds.starved_ms) continue;
    const measured = run.samples.every((sample) => number(sample.row, "available_incoming_kbps") !== undefined);
    const link = measured ? "on a link that measured clear" : "while loss and round trip were normal and the downlink was not measured";
    const { why, rows } = starvedCause(call, run, thresholds);
    const notes = [...why.notes, ...(measured ? [] : ["bandwidth not measured: the client logs no available_incoming_kbps, so a slow downlink is not ruled out"])];
    found.push(finding("starved_viewer", run.participant, run.from, run.to, `received video at ${peak(run)} kbps or less for ${seconds(run.to - run.from)} s ${link}`, { ...why, notes }, [...rowsOf(run), ...rows]));
  }
  for (const run of runsOf(call.samples, (row) => lowVideo(row, thresholds) && faulty(row, thresholds))) {
    if (run.to - run.from > thresholds.starved_ms) {
      found.push(finding("congested_viewer", run.participant, run.from, run.to, `received video at ${peak(run)} kbps or less for ${seconds(run.to - run.from)} s on a poor link`, cause(`the viewer's link was poor (${describeLink(run, thresholds)})`, "receiving", "client"), rowsOf(run)));
    }
  }
  return found;
}

function joinedAt(call, participant) {
  const db = call.database(participant);
  return db?.time ?? call.rowsOf(participant)[0]?.time;
}

function replacements(call, thresholds) {
  const found = [];
  for (const row of call.rows.filter((candidate) => candidate.event === "media.connection_replacement")) {
    const joined = joinedAt(call, row.participant);
    if (joined !== undefined && row.time - joined <= thresholds.early_replacement_ms) {
      found.push(finding("early_replacement", row.participant, joined, row.time, `had the media connection replaced ${seconds(row.time - joined)} s after joining`, cause(attr(row, "replacement_cause") ?? "cause not logged", "reconnecting", "API"), [row]));
    }
  }
  return found;
}

function hiddenVideo(call, thresholds) {
  const found = [];
  for (const run of runsOf(call.samples, (row) => hiddenByViewer(row) && number(row, "recv_bitrate_kbps") < thresholds.starved_floor_kbps)) {
    if (run.to - run.from > thresholds.silence_ms) {
      found.push(
        finding(
          "viewer_hid_video",
          run.participant,
          run.from,
          run.to,
          `hid its own video for ${seconds(run.to - run.from)} s, so little or no media arrived`,
          cause("the viewer's tile or page was hidden, which the SDK treats as a reason to stop receiving", "receiving", "client"),
          run.samples.map((sample) => sample.row),
          true,
        ),
      );
    }
  }
  return found;
}

/** A Participant whose presence lease ran out left without saying so: the client vanished. */
function expiries(call) {
  return call.rows
    .filter((row) => row.event === "db.journey_event" && attr(row, "journey_name") === "participant.connection_expired")
    .map((row) => {
      const unseen = number(row, "last_seen_age_ms");
      return finding(
        "connection_expired",
        row.participant,
        row.time,
        row.time,
        `left without leaving: its presence expired${unseen === undefined ? "" : ` after ${seconds(unseen)} s unseen`}`,
        cause(`the client stopped renewing its presence (${attr(row, "expiry_path") ?? "path not logged"}); the app or its network went away without a leave`, "leaving", "client"),
        [row],
      );
    });
}

/** Everything the thresholds call bad about the call, worst first. */
const KINDS = [
  "failed_join",
  "session_refused",
  "admission_refused",
  "never_connected",
  "peer_failed",
  "negotiation_failed",
  "node_shutdown",
  "retired",
  "connection_lost",
  "audio_stuck",
  "projection_mismatch",
  "media_silence",
  "publisher_silent",
  "starved_viewer",
  "congested_viewer",
  "early_replacement",
  "connection_expired",
  "viewer_hid_video",
];

export function findingsOf(call, thresholds) {
  const found = [...clientReports(call), ...sessions(call), ...mediaSilence(call, thresholds), ...publisherSilent(call, thresholds), ...lowBitrate(call, thresholds), ...replacements(call, thresholds), ...hiddenVideo(call, thresholds), ...expiries(call)];
  return found.sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.from - b.from);
}
