// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
import { seconds } from "./call.mjs";
import { cause, finding } from "./finding.mjs";
import { attr, number } from "./rows.mjs";

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
export function sessions(call) {
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
