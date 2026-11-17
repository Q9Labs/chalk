// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
import { cite, hiddenByViewer, runsOf, seconds, short } from "./call.mjs";
import { attr, number, participantHash } from "./rows.mjs";

/**
 * A finding says what a Participant lived through, at which stage of the media path it went wrong, on whose side, and which rows
 * prove it. `side` is one of client, API, Sync, SFU, recorder or unknown: unknown is the honest answer when the rows show
 * a failure but not who caused it. The first party named in `cause` (viewer, publisher) says whose client it was.
 */
const cause = (text, stage, side, notes = []) => ({ text, stage, side, notes });
const finding = (kind, participant, from, to, experience, why, rows, benign = false) => ({ kind, participant, from, to, experience, cause: why.text, stage: why.stage, side: why.side, notes: why.notes, benign, proof: cite(rows) });

/** The join step that failed first (the innermost one) and whose side owns it. */
const JOIN_STEP_SIDES = { acquire_initial_media: "client", access_initialize: "API", create_media_client: "SFU", start_media: "SFU", create_sync_client: "Sync", start_sync: "Sync", wait_for_sync_live: "Sync", confirm_entered: "Sync" };
/** The step of the media path a report names when media failed. */
const MEDIA_STEP_SIDES = { local_capture: "client", peer_connection: "client", access_refresh: "API", sfu_tracks: "SFU", sfu_close_tracks: "SFU", sfu_renegotiate: "SFU", sfu_publications: "SFU", sfu_subscriptions: "SFU" };
/** How far a received audio track got before it stopped, and which side owns the next step. */
const RECEIVE_STOPS = {
  announced: ["the track was announced but the client never asked for it", "client"],
  pull_requested: ["the client asked for the track and got no answer", "SFU"],
  pull_failed: ["the client's request for the track failed", "SFU"],
  pull_succeeded: ["the track was pulled but never arrived", "SFU"],
  track_received: ["the track arrived but no bytes flowed", "SFU"],
  bytes_flowing: ["bytes flowed but the audio element did not play", "client"],
  element_bound: ["the audio element was bound but did not play", "client"],
};

/** The client report carries its events as a JSON string; a report that does not parse names no step. */
function reportOf(report) {
  try {
    const parsed = JSON.parse(String(attr(report, "report") ?? "{}"));
    return { trigger: attr(report, "trigger") ?? parsed.trigger, events: Array.isArray(parsed.events) ? parsed.events : [] };
  } catch {
    return { trigger: attr(report, "trigger"), events: [] };
  }
}

/** A 4xx answer is logged as `http.request` with its status; `http.failure` is the 5xx and transport case. */
const failedRequest = (row) => row.event === "http.failure" || (row.event === "http.request" && number(row, "status") >= 400);

function joinCause(rows, report, events) {
  const failure = rows.find((row) => failedRequest(row) && ((row.journey && row.journey === report.journey) || (row.trace && row.trace === report.trace)));
  if (failure) return { why: cause(`the API refused the request (${attr(failure, "error_code") ?? (number(failure, "status") ? `HTTP ${number(failure, "status")}` : "code not logged")})`, "joining", "API"), proof: [report, failure] };
  const step = events.find((event) => event.event === "space_join_span" && event.outcome === "failed" && event.step in JOIN_STEP_SIDES);
  if (step) return { why: cause(`the join failed at ${step.step} (${step.code ?? "code not logged"}) after ${seconds(step.duration_ms ?? 0)} s`, "joining", JOIN_STEP_SIDES[step.step]), proof: [report] };
  return { why: cause("unknown: no failed API request shares the report's journey id and the report names no failed step", "joining", "unknown"), proof: [report] };
}

/** One finding per failed join. */
function failedJoin(call, report, events) {
  const { why, proof } = joinCause(call.rows, report, events);
  return [finding("failed_join", report.participant, report.time, report.time, "could not join", why, proof)];
}

/** One finding per audio track the viewer could not hear, named by how far the receive got. */
function stuckAudio(_call, report, events) {
  return events
    .filter((event) => event.event === "audio_receive_stuck" && ["microphone", "screen_audio"].includes(event.source))
    .map((stuck) => {
      const [stop, side] = RECEIVE_STOPS[stuck.receive_state] ?? [`the furthest receive state was ${stuck.receive_state ?? "not logged"}`, "unknown"];
      const detail = [stuck.media_error_kind && stuck.media_error_kind !== "unknown" ? `error ${stuck.media_error_kind}` : undefined, stuck.media_error_step ? `at ${stuck.media_error_step}` : undefined].filter(Boolean).join(" ");
      return finding("audio_stuck", report.participant, report.time, report.time, `could not hear the ${stuck.source.replace("_", " ")} for ${seconds(stuck.duration_ms ?? 0)} s`, cause(`${stop}${detail ? ` (${detail})` : ""}`, "receiving", side), [report]);
    });
}

function projectionMismatch(_call, report) {
  const why = cause("the client reports a publication that is on while its projection is off; the report does not say which side is wrong", "publishing", "unknown");
  return [finding("projection_mismatch", report.participant, report.time, report.time, "reported its published media projected off", why, [report])];
}

function lostConnection(_call, report, events) {
  const failed = events.findLast((event) => event.outcome === "failed" || event.code || event.media_error_step);
  const side = MEDIA_STEP_SIDES[failed?.media_error_step] ?? "client";
  const last = `the client's last failure was ${failed?.code ?? failed?.media_error_kind ?? "not logged"}${failed?.media_error_step ? ` at ${failed.media_error_step}` : ""}`;
  const experience = reportOf(report).trigger === "recovery_exhausted" ? "ran out of attempts to recover its connection" : "lost its connection";
  return [finding("connection_lost", report.participant, report.time, report.time, experience, cause(last, "reconnecting", side), [report])];
}

/** What a connection report says went wrong, by its trigger. */
const REPORT_RULES = { join_failed: failedJoin, audio_receive_stuck: stuckAudio, media_projection_mismatch: projectionMismatch, connection_lost: lostConnection, recovery_exhausted: lostConnection };

/** What the client itself reported: join failures, lost connections, audio it could not hear. */
function clientReports(call) {
  return call.rows
    .filter((row) => row.event === "sdk.connection_report")
    .flatMap((report) => {
      const { trigger, events } = reportOf(report);
      return (REPORT_RULES[trigger] ?? (() => []))(call, report, events);
    });
}

const PEER_EVENTS = ["sfu.peer.state", "sfu.ice.state", "sfu.dtls.state"];

/** What the node saw of the peer connection before the session closed: the states, and the last ICE and DTLS one. */
function peerStates(call, closed) {
  const states = call.nodeEvents(closed.connection).filter((row) => PEER_EVENTS.includes(row.event) && row.time <= closed.time);
  const last = (event) => states.findLast((row) => row.event === event && attr(row, "state") !== "closed");
  return { states, ice: last("sfu.ice.state"), dtls: last("sfu.dtls.state"), began: states.some((row) => attr(row, "state") !== "closed") };
}

/** The client's own stats for a connection, when they say it never settled on a candidate pair. */
function clientView(call, connection) {
  const stats = call.samples.filter((sample) => sample.connection === connection);
  if (stats.length === 0) return { rows: [], notes: ["the client uploaded no stats for this connection"] };
  const first = stats[0].row;
  const bitrate = stats.some((sample) => attr(sample.row, "recv_bitrate_kbps") !== undefined || attr(sample.row, "send_bitrate_kbps") !== undefined);
  const client = [attr(first, "client_family"), attr(first, "client_os")].filter(Boolean).join(" ");
  const types = [...new Set(stats.map((sample) => attr(sample.row, "connection_type")).filter(Boolean))].join(", ");
  return { rows: [first, stats.at(-1).row], notes: [`the client uploaded ${stats.length} stats samples for this connection${client ? ` (${client})` : ""}; ${bitrate ? "some carried a bitrate" : "none carried a bitrate"}; connection type ${types || "not logged"}`] };
}

/** A later connected ICE state of the same Participant: the call recovered, and how long it took. */
function recoveredNote(call, closed) {
  const later = call.rows.find((row) => row.event === "sfu.ice.state" && row.participant === closed.participant && row.time > closed.time && attr(row, "state") === "connected");
  return later ? [`the Participant connected again ${seconds(later.time - closed.time)} s later (${later.id})`] : [];
}

const CLOSE_FAULTS = ["never_connected", "peer_failed", "negotiation_failed", "node_shutdown", "retired"];

/** Why a node session closed: the causes that mean the call lost its media, with what the node saw before it closed. */
function sessionCause(call, closed, sessionCause) {
  const { ice, dtls, began } = peerStates(call, closed);
  const lifetime = number(closed, "lifetime_ms");
  const after = lifetime === undefined ? "" : ` after ${seconds(lifetime)} s`;
  const capture = attr(closed, "session_kind") === "capture";
  const side = capture ? "recorder" : "unknown";
  const view = clientView(call, closed.connection);
  const notes = [...view.notes, ...recoveredNote(call, closed)];
  const seen = [ice && `ICE ${attr(ice, "state")}`, dtls && `DTLS ${attr(dtls, "state")}`].filter(Boolean).join(", ");
  const why = {
    never_connected: began
      ? cause(`no media path: the session closed never_connected${after}; the node saw ${seen || "only peer states"} but never a connected path, so the path between the ${capture ? "recorder" : "client"} and the node failed (the rows do not say which end blocked it)`, "connecting", side, notes)
      : cause(`no media path: the session closed never_connected${after}, and the node logged no peer, ICE or DTLS state before it closed, so negotiation never began on the node (the rows do not show whether the ${capture ? "recorder" : "client"} sent its offer)`, "connecting", side, notes),
    peer_failed: cause(`ICE or DTLS failed${after} (${seen || "no state logged"}); the node's error text is not exported, so the rows do not say which end failed`, "connecting", side, notes),
    negotiation_failed: cause(`the node could not apply an offer or answer${after}; its error text is not exported, so the rows do not say whose offer was wrong`, "connecting", side, notes),
    node_shutdown: cause(`the node stopped while the session was open${after}`, "forwarding", "SFU", notes),
    retired: cause(`the Episode's media binding moved to a newer generation and retired the session${after}`, "forwarding", "SFU", notes),
  }[sessionCause];
  return { why, rows: [closed, ...peerStates(call, closed).states.slice(-3), ...view.rows.slice(0, 1)] };
}

/** What the SFU node reports about a Participant's session: closes that cost the call its media, refusals, failed ICE or DTLS. */
function sessions(call) {
  const found = [];
  const reported = new Set();
  for (const closed of call.rows.filter((row) => row.event === "sfu.session.closed" && CLOSE_FAULTS.includes(attr(row, "cause")))) {
    const { why, rows } = sessionCause(call, closed, attr(closed, "cause"));
    reported.add(closed.connection);
    const lifetime = number(closed, "lifetime_ms") ?? 0;
    const registered = call.nodeEvents(closed.connection).find((row) => row.event === "sfu.session.registered");
    found.push(finding(attr(closed, "cause"), closed.participant, registered?.time ?? closed.time - lifetime, closed.time, `had no media path: the SFU closed its session (${attr(closed, "cause")})`, why, registered ? [registered, ...rows] : rows));
  }
  for (const refused of call.rows.filter((row) => row.event === "sfu.session.refused")) {
    found.push(finding("session_refused", refused.participant, refused.time, refused.time, "was refused a media session", cause(`the node refused the session (${attr(refused, "code") ?? "code not logged"})`, "joining", "SFU"), [refused]));
  }
  for (const refused of call.rows.filter((row) => row.event === "sfu.admission.refused")) {
    found.push(finding("admission_refused", refused.participant, refused.time, refused.time, "was refused admission by the node", cause(`the node refused admission (${attr(refused, "reason") ?? "reason not logged"}, ${attr(refused, "sessions") ?? "?"} sessions open)`, "joining", "SFU"), [refused]));
  }
  for (const state of call.rows.filter((row) => (row.event === "sfu.ice.state" || row.event === "sfu.dtls.state") && attr(row, "state") === "failed" && !reported.has(row.connection))) {
    found.push(
      finding(
        "peer_failed",
        state.participant,
        state.time,
        state.time,
        `had its ${state.event === "sfu.ice.state" ? "ICE" : "DTLS"} connection fail`,
        cause(`the node logged ${state.event} failed; the path between the client and the node broke, and the rows do not say which end broke it`, "connecting", "unknown"),
        [state],
      ),
    );
  }
  return found;
}

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
