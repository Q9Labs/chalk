// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
import { clock, seconds } from "./call.mjs";
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

/** A later connected ICE state of the same Participant: the call recovered by connecting again, and how long it took. */
function recoveredNote(call, closed) {
  const later = call.rows.find((row) => row.event === "sfu.ice.state" && row.participant === closed.participant && row.time > closed.time && attr(row, "state") === "connected");
  return later ? [`the Participant connected again ${seconds(later.time - closed.time)} s later (${later.id})`] : [];
}

/** The kind of finding each outcome of a session is, and what it says the Participant lived through. */
const OUTCOME_FAULTS = {
  never_connected: ["never_connected", (closer) => `had no media path: the SFU closed its session (${closer})`],
  failed: ["negotiation_failed", (closer) => `had no media path: the SFU could not negotiate its session (${closer})`],
  dropped: ["dropped", (closer) => `lost its media path and did not get it back: the SFU closed its session (${closer})`],
  interrupted: ["node_shutdown", () => "lost its media session when the node stopped"],
};

/** The fault a session's end is: its outcome says it, and a session the Episode's newer binding retired is a fault though it ended normally. */
function faultOf(end) {
  const known = OUTCOME_FAULTS[end.outcome];
  if (known) return { kind: known[0], experience: known[1](end.cause ?? "cause not logged") };
  return end.cause === "retired" ? { kind: "retired", experience: "had its media session retired by a newer binding" } : undefined;
}

/** The node's own account of a failed negotiation: the step that failed and why. */
function negotiationNote(call, connection) {
  const failed = call.nodeEvents(connection).findLast((row) => row.event === "sfu.negotiation.failed");
  return failed ? { text: ` (step ${attr(failed, "step") ?? "not logged"}, ${attr(failed, "reason") ?? "reason not logged"})`, row: failed } : { text: "", row: undefined };
}

/** What the durable outcome says about the session's outage, which survives the node's events. */
function outageNotes(end) {
  const drops = number(end.row, "disconnects");
  const outage = number(end.row, "outage_ms");
  return drops > 0 ? [`the session was down ${seconds(outage ?? 0)} s in ${drops} ${drops === 1 ? "drop" : "drops"}`] : [];
}

/** Why a node session ended in a fault: what the node saw before it closed, or, when the node's events are gone, what the durable row says. */
function sessionCause(call, end, kind) {
  const closed = end.row;
  const { ice, dtls, began } = peerStates(call, closed);
  const observed = call.nodeEvents(closed.connection).some((row) => row !== closed);
  const lifetime = number(closed, "lifetime_ms");
  const after = lifetime === undefined ? "" : ` after ${seconds(lifetime)} s`;
  const capture = attr(closed, "session_kind") === "capture";
  const side = capture ? "recorder" : "unknown";
  const view = clientView(call, closed.connection);
  const negotiation = negotiationNote(call, closed.connection);
  const kept = observed ? [] : [`the node's own events for this session are not in the log dataset (past its retention, or never exported), so the ${end.logged ? "closing line" : "durable outcome saved with the Participant"} is the proof`];
  const notes = [...view.notes, ...recoveredNote(call, closed), ...outageNotes(end), ...kept];
  const seen = [ice && `ICE ${attr(ice, "state")}`, dtls && `DTLS ${attr(dtls, "state")}`].filter(Boolean).join(", ");
  const peer = capture ? "recorder" : "client";
  const why = {
    never_connected: !observed
      ? cause(`no media path: the session closed never_connected${after}${end.cause && end.cause !== "never_connected" ? ` (closed by ${end.cause})` : ""}; the node's peer states for it are not available, so the rows do not say which end blocked the path`, "connecting", side, notes)
      : began
        ? cause(`no media path: the session closed never_connected${after}; the node saw ${seen || "only peer states"} but never a connected path, so the path between the ${peer} and the node failed (the rows do not say which end blocked it)`, "connecting", side, notes)
        : cause(`no media path: the session closed never_connected${after}, and the node logged no peer, ICE or DTLS state before it closed, so negotiation never began on the node (the rows do not show whether the ${peer} sent its offer)`, "connecting", side, notes),
    dropped:
      end.cause === "peer_failed"
        ? cause(`ICE or DTLS failed${after} (${seen || "no state logged"}); the node's error text is not exported, so the rows do not say which end failed`, "connecting", side, notes)
        : cause(`the session was closed (${end.cause ?? "cause not logged"}) while the connection was down${after}, so it never recovered; the rows do not say which end broke the path`, "connecting", side, notes),
    negotiation_failed: cause(`the node could not apply an offer or answer${negotiation.text}${after}; its error text is not exported, so the rows do not say whose offer was wrong`, "connecting", side, notes),
    node_shutdown: cause(`the node stopped while the session was open${after}`, "forwarding", "SFU", notes),
    retired: cause(`the Episode's media binding moved to a newer generation and retired the session${after}`, "forwarding", "SFU", notes),
  }[kind];
  return { why, rows: [closed, ...(negotiation.row ? [negotiation.row] : []), ...peerStates(call, closed).states.slice(-3), ...view.rows.slice(0, 1)] };
}

/** Sessions that ended in a fault: the node's closing line while the store keeps it, and the durable outcome after. */
function endFindings(call, reported) {
  const found = [];
  for (const end of call.ends) {
    const fault = faultOf(end);
    if (!fault) continue;
    const { why, rows } = sessionCause(call, end, fault.kind);
    reported.add(end.connection);
    const lifetime = number(end.row, "lifetime_ms") ?? 0;
    const registered = call.nodeEvents(end.connection).find((row) => row.event === "sfu.session.registered");
    found.push(finding(fault.kind, end.participant, registered?.time ?? end.row.time - lifetime, end.row.time, fault.experience, why, registered ? [registered, ...rows] : rows));
  }
  return found;
}

/** The drops a connection recovered from: the node's `connected` states that end an outage, each with the outage it ends. */
function recoveries(call) {
  const found = [];
  const states = call.rows.filter((row) => row.event === "sfu.peer.state" && attr(row, "state") === "connected" && number(row, "outage_ms") > 0);
  for (const connection of new Set(states.map((row) => row.connection))) {
    const own = states.filter((row) => row.connection === connection);
    found.push({ connection, participant: own[0].participant, drops: own.map((row) => ({ from: row.time - number(row, "outage_ms"), to: row.time, ms: number(row, "outage_ms") })), rows: own });
  }
  for (const end of call.ends.filter((candidate) => candidate.outcome === "left" && !faultOf(candidate) && number(candidate.row, "disconnects") > 0 && number(candidate.row, "outage_ms") > 0 && !found.some((one) => one.connection === candidate.connection))) {
    found.push({ connection: end.connection, participant: end.participant, drops: Array.from({ length: number(end.row, "disconnects") }, () => ({ ms: number(end.row, "outage_ms") / number(end.row, "disconnects") })), total: true, rows: [end.row] });
  }
  return found;
}

/** Other Participants who started a second session while this one was down: a rejoin that the recovery should have made unnecessary. */
function rejoinsDuring(call, participant, from, to) {
  const registered = call.rows.filter((row) => row.event === "sfu.session.registered" && row.participant && row.participant !== participant);
  return registered.filter((row) => row.time >= from && row.time <= to && registered.some((earlier) => earlier.participant === row.participant && earlier.time < row.time && earlier.connection !== row.connection));
}

/**
 * A drop the connection recovered from on its own, with its length. The criterion is that a 10 s drop recovers without anyone else rejoining,
 * so a recovery during which another Participant had to start a new session is a failure of it.
 */
function recoveredDrops(call) {
  return recoveries(call).map((recovery) => {
    const timed = recovery.total ? undefined : recovery.drops;
    const first = timed ? Math.min(...timed.map((drop) => drop.from)) : (recovery.rows[0]?.time ?? 0);
    const last = timed ? Math.max(...timed.map((drop) => drop.to)) : first;
    const lengths = recovery.drops.map((drop) => drop.ms);
    const total = lengths.reduce((sum, ms) => sum + ms, 0);
    const rejoined = timed ? [...new Set(timed.flatMap((drop) => rejoinsDuring(call, recovery.participant, drop.from, drop.to)))] : [];
    const once = `${seconds(total)} s`;
    const lengthText = lengths.length === 1 ? once : `${lengths.length} times (${once} in all)`;
    const experience = `lost its media path for ${lengthText}${timed ? ` at ${clock(first)} UTC` : ""} and ${rejoined.length > 0 ? "recovered, but other Participants had to rejoin meanwhile" : "recovered without rejoining"}`;
    const rejoinNote = rejoined.length > 0 ? [`${new Set(rejoined.map((row) => row.participant)).size} other Participants started a new session while it was down, so the recovery was not on its own`] : [];
    const why = cause(
      rejoined.length > 0
        ? "the connection recovered, but other Participants had to rejoin while it was down"
        : `the node saw the peer connection down for ${once}${lengths.length === 1 ? "" : ` in ${lengths.length} drops`} and connected again with the same session${recovery.total ? "; only the durable total is kept, so the times of the drops are not known" : ""}`,
      "reconnecting",
      "unknown",
      rejoinNote,
    );
    return { ...finding(rejoined.length > 0 ? "drop_needed_rejoin" : "recovered_drop", recovery.participant, first, last, experience, why, [...recovery.rows, ...rejoined]), benign: rejoined.length === 0 };
  });
}

/** Control calls whose failure on a session that is already gone is the expected end of cleanup, never a publishing, renegotiation or update that was lost. */
const CLEANUP_OPERATIONS = new Set(["close_tracks", "remove_session"]);

/** `sfu.control.failed`: a control call to the node that failed, with the HTTP status and problem code. A 5xx is the node's, a 4xx is the request's. */
function controlFailures(call) {
  return call.rows
    .filter((row) => row.event === "sfu.control.failed" && !(attr(row, "code") === "session_gone" && CLEANUP_OPERATIONS.has(attr(row, "operation"))))
    .map((row) => {
      const status = number(row, "status");
      const side = status >= 500 ? "SFU" : "API";
      return finding(
        "control_failed",
        row.participant,
        row.time,
        row.time,
        `had a media control call fail (${attr(row, "operation") ?? "operation not logged"})`,
        cause(`the node answered ${attr(row, "operation") ?? "the call"} with HTTP ${status ?? "status not logged"} (${attr(row, "code") ?? "code not logged"})`, "connecting", side),
        [row],
      );
    });
}

/** What the SFU node reports about a Participant's session: closes that cost the call its media, recovered drops, refusals, failed control calls, failed ICE or DTLS. */
export function sessions(call) {
  const reported = new Set();
  const found = [...endFindings(call, reported), ...recoveredDrops(call), ...controlFailures(call)];
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
