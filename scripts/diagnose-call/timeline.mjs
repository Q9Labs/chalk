// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
import { cite, shortConnection } from "./call.mjs";
import { mediaOf, middle, streamSummary, trackSummary } from "./quality.mjs";
import { attr, flag, number } from "./rows.mjs";

const STEP_LIMIT = 60;
const NORMAL_CLOSES = ["removed", "replaced", "episode_ended", "peer_closed"];
const NORMAL_OUTCOMES = ["left", "ended"];
const SESSION_FIELDS = ["outcome", "cause", "lifetime_ms", "connect_ms", "disconnects", "outage_ms", "publications", "subscriptions"];

/** A session ended in a way that is part of a call: the node names its outcome, and a line from before outcomes is read by its cause. */
const endedNormally = (row) => (attr(row, "outcome") ? NORMAL_OUTCOMES.includes(attr(row, "outcome")) : NORMAL_CLOSES.includes(attr(row, "cause")));

const detail = (row, names) =>
  names
    .map((name) => (attr(row, name) === undefined ? undefined : `${name}=${attr(row, name)}`))
    .filter(Boolean)
    .join(" ");
const said = (text, row, names) => {
  const extra = detail(row, names);
  return extra ? `${text} (${extra})` : text;
};
const step = (stage, side, text) => ({ stage, side, text });

/**
 * How one row reads as a step of a Participant's call: the stage of the media path it belongs to, whose side logged it, and what
 * it says. A new event needs one line here to read well; until it has one, `generic` still shows it with its own fields.
 */
const STEPS = {
  "sfu.session.registered": (row) => step("connecting", "SFU", said("the node registered the session", row, ["session_kind", "allocation"])),
  "media_plane.selected": (row) => step("joining", "API", said("the API chose the media plane", row, ["provider", "selected_by"])),
  "sfu.session.refused": (row) => step("joining", "SFU", said("the node refused the session", row, ["code"])),
  "sfu.admission.refused": (row) => step("joining", "SFU", said("the node refused admission", row, ["reason", "sessions"])),
  "sfu.session.closed": (row) => step(endedNormally(row) ? "leaving" : "connecting", "SFU", said("the node closed the session", row, SESSION_FIELDS)),
  "db.media_session": (row) => step(endedNormally(row) ? "leaving" : "connecting", "SFU", said("the durable outcome of the media session", row, SESSION_FIELDS)),
  "sfu.peer.state": (row) => step("connecting", "SFU", said(`peer connection ${attr(row, "state") ?? "state not logged"}`, row, ["connect_ms", "outage_ms"])),
  "sfu.negotiation.failed": (row) => step("connecting", "SFU", said("the node failed a negotiation step", row, ["step", "reason"])),
  "sfu.control.failed": (row) => step("connecting", "SFU", said("a control call to the node failed", row, ["operation", "status", "code"])),
  "sfu.publication.held": (row) => step("publishing", "SFU", said(flag(row, "held") ? "the node applied a mute" : "the node applied an unmute", row, ["source", "media_kind", "unmute_seq"])),
  "sfu.unmute.first_voiced": (row) => step("publishing", "SFU", said("the first voiced packet after an unmute reached the node", row, ["source", "unmute_seq", "since_unmute_ms"])),
  "sfu.unmute.first_forwarded": (row) => step("forwarding", "SFU", said("the node forwarded the first voiced packet after an unmute", row, ["source", "unmute_seq", "since_unmute_ms", "since_voiced_ms"])),
  "db.media_plane_change": (row) => step("joining", "API", said(`the ${attr(row, "scope") ?? "a"} media plane setting changed from ${attr(row, "old_plane") ?? "?"} to ${attr(row, "new_plane") ?? "?"}`, row, ["actor", "reason"])),
  "sfu.ice.state": (row) => step("connecting", "SFU", said(`ICE ${attr(row, "state") ?? "state not logged"}`, row, ["path", "protocol"])),
  "sfu.dtls.state": (row) => step("connecting", "SFU", `DTLS ${attr(row, "state") ?? "state not logged"}`),
  "sfu.publication.started": (row) => step("publishing", "SFU", said("the node accepted a publication", row, ["source", "media_kind"])),
  "sfu.publication.stopped": (row) => step("publishing", "SFU", said("the node stopped a publication", row, ["source", "media_kind", "reason"])),
  "sfu.subscription.started": (row) => step("forwarding", "SFU", said("the node started a subscription", row, ["source", "media_kind", "mid"])),
  "sfu.subscription.stopped": (row) => step("forwarding", "SFU", said("the node stopped a subscription", row, ["source", "media_kind", "mid", "reason"])),
  "sfu.subscription.paused": (row) => step("forwarding", "SFU", said("the node paused a subscription", row, ["source", "media_kind", "mid", "reason"])),
  "sfu.subscription.resumed": (row) => step("forwarding", "SFU", said("the node resumed a subscription", row, ["source", "media_kind", "mid", "was"])),
  "sfu.subscription.layer": (row) => step("forwarding", "SFU", said("the node set the forwarded layer", row, ["source", "media_kind", "layer"])),
  "sfu.subscription.congestion": (row) => step("forwarding", "SFU", said("the node's bandwidth estimate changed", row, ["layer", "reason", "estimate_bps", "delivered_share", "loss_share", "decrease_cause"])),
  "sfu.camera.plan": (row) => step("publishing", "SFU", said("the node planned the publisher's camera", row, ["level", "was"])),
  "sfu.source.lease_opened": (row) => step("publishing", "SFU", said("the node opened a source lease", row, ["source", "revision"])),
  "sfu.source.lease_lost": (row) => step("publishing", "SFU", said("the node lost a source lease", row, ["source", "cause", "revision"])),
  "media.connection_replacement": (row) => step("reconnecting", "API", said("the API replaced the media connection", row, ["replacement_cause"])),
  "http.request": (row) => step("joining", "API", said("API request", row, ["route", "status"])),
  "sdk.connection_report": (row) => step("reporting", "client", said("the client sent a connection report", row, ["trigger"])),
  "http.failure": (row) => step("joining", "API", said("an API request failed", row, ["status", "error_code", "route"])),
  "db.sync_media_pause": (row) => step("forwarding", "Sync", said("Sync paused a source", row, ["source"])),
  "db.sync_media_stop": (row) => step("forwarding", "Sync", said("Sync stopped a source", row, ["source", "revision"])),
  "db.media_refresh": () => step("reconnecting", "API", "the API refreshed the media connection"),
  "db.sfu_retirement_debt": (row) => step("leaving", "SFU", said("a media node still owed a retirement for this Episode", row, ["node", "generation", "attempts"])),
  "db.recording": (row) => step("recording", "recorder", said("the recording row", row, ["status", "failure_code"])),
  "db.journey_event": (row) => step("leaving", "API", said(`the ledger recorded ${attr(row, "journey_name") ?? "an event"}`, row, ["expiry_path", "last_seen_age_ms"])),
  "db.presence_lease": () => step("leaving", "API", "the Participant's presence lease row exists"),
};

const generic = (row) => step(row.source === "sync" ? "joining" : "other", { api: "API", sync: "Sync", sfu: "SFU", client: "client", recorder: "recorder", db: "API" }[row.source] ?? "unknown", said(row.event, row, ["state", "cause", "reason", "code", "trigger"]));

/** One step per connection for its stats, because a 40-minute call has hundreds of samples and the rules already name the bad stretches. */
function statsSteps(call, participant) {
  const byConnection = new Map();
  for (const sample of call.samples.filter((candidate) => candidate.participant === participant)) byConnection.set(sample.connection, [...(byConnection.get(sample.connection) ?? []), sample]);
  return [...byConnection].map(([connection, samples]) => {
    const median = (name) => middle(samples.map((sample) => number(sample.row, name)));
    const worst = (name) => Math.max(...samples.map((sample) => number(sample.row, name)).filter(Number.isFinite));
    const unmeasured = samples.every((sample) => number(sample.row, "available_incoming_kbps") === undefined);
    const parts = [
      `${samples.length} stats samples on connection ${shortConnection(connection)}`,
      [attr(samples[0].row, "client_family"), attr(samples[0].row, "client_os")].filter(Boolean).join(" ") || undefined,
      attr(samples[0].row, "connection_type") ? `connection type ${attr(samples[0].row, "connection_type")}` : undefined,
      median("recv_bitrate_kbps") === undefined && median("send_bitrate_kbps") === undefined ? "no bitrate in any sample" : undefined,
      median("recv_bitrate_kbps") === undefined ? undefined : `receives ${median("recv_bitrate_kbps")} kbps at median`,
      median("send_bitrate_kbps") === undefined ? undefined : `sends ${median("send_bitrate_kbps")} kbps at median`,
      Number.isFinite(worst("recv_loss_pct")) ? `loss ${worst("recv_loss_pct")}% at worst` : undefined,
      Number.isFinite(worst("rtt_ms")) ? `round trip ${worst("rtt_ms")} ms at worst` : undefined,
      median("recv_bitrate_kbps") === undefined ? undefined : unmeasured ? "bandwidth not measured" : `${Math.min(...samples.map((sample) => number(sample.row, "available_incoming_kbps")).filter(Number.isFinite))} kbps available at lowest`,
    ].filter(Boolean);
    return { time: samples[0].start, ...step("receiving", "client", parts.join("; ")), proof: cite(samples.map((sample) => sample.row)) };
  });
}

/** The database rows say when a Participant joined and left, and why. */
function lifecycleSteps(call, participant) {
  const db = call.database(participant);
  if (!db) return [];
  const steps = [{ time: db.time, ...step("joining", "API", said(`joined as ${attr(db, "role") ?? "an unnamed role"}`, db, ["status", "generation"])), proof: cite([db]) }];
  const left = attr(db, "left_at");
  if (left) steps.push({ time: Date.parse(left), ...step("leaving", "API", `left (reason: ${attr(db, "last_left_reason") ?? "not logged"})`), proof: cite([db]) });
  return steps;
}

/** A normal lease revocation as the Participant leaves is cleanup, and the step says so. */
const leaveNote = (call, row) => {
  const departed = call.departedAt(row.participant);
  return row.event === "sfu.source.lease_lost" && departed !== undefined && Math.abs(row.time - departed) <= 5000 ? " as the Participant left, which is normal cleanup" : "";
};

/** Rows the timeline summarizes with one step per connection and not one step each: a call has hundreds of them. */
const SKIPPED = ["sdk.call_stats", "db.episode", "db.participant", "sfu.media.ingress", "sfu.media.egress", "sfu.media.transport"];

/** What the node measured of the Participant's tracks and downlink, one step each, from the node's own stats rows. */
function nodeMediaSteps(call, participant) {
  const media = mediaOf(call);
  const tracks = media.ingress.filter((track) => track.participant === participant).map((track) => ({ time: track.rows[0].time, ...step("publishing", "SFU", trackSummary(track)), proof: cite(track.rows) }));
  const streams = media.egress.filter((stream) => stream.participant === participant).map((stream) => ({ time: stream.rows[0].time, ...step("receiving", "SFU", streamSummary(stream)), proof: cite(stream.rows) }));
  return [...tracks, ...streams];
}

function stepsOf(call, participant, findings) {
  const own = call.rowsOf(participant).filter((row) => !SKIPPED.includes(row.event));
  const rows = own.map((row) => {
    const read = (STEPS[row.event] ?? generic)(row);
    return { time: row.time, ...read, text: `${read.text}${leaveNote(call, row)}`, proof: cite([row]) };
  });
  const found = findings
    .filter((finding) => finding.participant === participant)
    .map((finding) => ({ time: finding.from, stage: finding.stage, side: finding.side, text: [finding.experience, finding.cause, ...finding.notes].join("; "), proof: finding.proof, finding: finding.benign ? "note" : "problem" }));
  return [...lifecycleSteps(call, participant), ...statsSteps(call, participant), ...nodeMediaSteps(call, participant), ...rows, ...found];
}

/** Keeps every finding and the first and last steps; the middle is left out with a count, so a 40-minute call stays readable. */
function limited(steps) {
  const plain = steps.filter((candidate) => !candidate.finding);
  if (plain.length <= STEP_LIMIT) return { steps, left: 0 };
  const keep = new Set([...plain.slice(0, STEP_LIMIT / 2), ...plain.slice(-STEP_LIMIT / 2)]);
  return { steps: steps.filter((candidate) => candidate.finding || keep.has(candidate)), left: plain.length - STEP_LIMIT };
}

/**
 * One timeline per Participant, then one for the rows that name no Participant (the Episode, recordings, debts). Each step names
 * its stage, the side that owns it and the ids of the rows that prove it.
 */
export function timelines(call, findings) {
  const episodeRows = call.rows.filter((row) => !row.participant && row.event !== "db.episode");
  const owned = call.participants.map((participant) => {
    const db = call.database(participant);
    const { steps, left } = limited(stepsOf(call, participant, findings).sort((a, b) => a.time - b.time));
    return { participant, role: db ? attr(db, "role") : undefined, joined: db?.time, left: attr(db ?? { attrs: {} }, "left_at"), leftReason: db ? attr(db, "last_left_reason") : undefined, steps, left_out: left };
  });
  const shared = episodeRows.map((row) => ({ time: row.time, ...(STEPS[row.event] ?? generic)(row), proof: cite([row]) }));
  const unattributed = findings.filter((finding) => !finding.participant).map((finding) => ({ time: finding.from, stage: finding.stage, side: finding.side, text: [finding.experience, finding.cause, ...finding.notes].join("; "), proof: finding.proof, finding: finding.benign ? "note" : "problem" }));
  return { participants: owned.sort((a, b) => (a.steps[0]?.time ?? 0) - (b.steps[0]?.time ?? 0)), episode: [...shared, ...unattributed].sort((a, b) => a.time - b.time) };
}
