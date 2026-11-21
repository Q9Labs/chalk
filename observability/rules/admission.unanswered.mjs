// @ts-check
/**
 * admission.unanswered: a knock expired while a host was positioned but never saw it, or a host's answer never committed.
 * Host positioning has two independent witnesses: a Participant row with manageAdmission, active at request time, plus its
 * sync authentication; or a Dashboard Account whose call page showed for the Space, or whose edge call-status reads kept the
 * window. The request's db rows and sync state are one decision. decided_at, not the op's ok, proves a decision.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "admission.unanswered";

const knock_shown_ms = 10_000;
const knock_seen_ms = 5_000;
const host_visible_ms = 30_000;
const decided_proof_ms = 5_000;
const call_status_cadence_ms = 10_000;

export const expected = "a knock shown to a positioned host within 10 s, or nobody positioned to see it";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "episode";

/** @param {Observation} o */
const requestKey = (o) => /** @type {string | undefined} */ (o.value.admission_request_id);

/** @param {readonly Observation[]} reads @param {number} from @param {number} to */
const callStatusCadence = (reads, from, to) => {
  const edge = reads.filter((o) => o.source === "edge").sort((a, b) => a.window.from_ms - b.window.from_ms);
  if (edge.length === 0) return false;
  let cursor = from;
  const end = Math.min(to, from + host_visible_ms);
  for (const read of edge) {
    if (read.window.from_ms > cursor + call_status_cadence_ms) return false;
    if (read.window.from_ms >= end) return true;
    cursor = read.window.from_ms;
  }
  return cursor + call_status_cadence_ms >= end;
};

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  for (const name of ["admission.request", "admission.host", "admission.host_reads", "admission.knock_shown", "admission.decide"]) {
    if (readings[name].kind === "unknown") return { status: "unknown", reason: name === "admission.host_reads" ? "edge unavailable" : "host client incomplete" };
  }
  const request = readings["admission.request"];
  if (request.kind !== "present") return { status: "pass" };
  const rows = request.observations;
  const handle = requestKey(rows[0]);
  const row = rows.find((o) => (o.value.admission_status === "expired" || o.value.admission_status === "pending") && requestKey(o) === handle) ?? rows[0];
  const requestedAt = /** @type {number} */ (row.value.requested_at ?? row.window.from_ms);
  const expiresAt = /** @type {number} */ (row.value.expires_at ?? window.to_ms ?? requestedAt);
  const decidedAt = /** @type {number | null} */ (row.value.decided_at ?? null);
  const knockWindow = { from_ms: requestedAt, to_ms: expiresAt };

  const hosts = readings["admission.host"].kind === "present" ? readings["admission.host"].observations : [];
  const hostReads = readings["admission.host_reads"].kind === "present" ? readings["admission.host_reads"].observations : [];
  const knocks = readings["admission.knock_shown"].kind === "present" ? readings["admission.knock_shown"].observations : [];
  const decides = readings["admission.decide"].kind === "present" ? readings["admission.decide"].observations : [];

  // A host's answer that never committed: op ended error, or ok with no decided_at within 5 s.
  const decide = decides.find((o) => requestKey(o) === handle);
  if (decide) {
    if (decide.claim === "error") {
      return {
        status: "finding",
        outcome: "broken",
        window: decide.window,
        hop: "admission_decide",
        module: "react.admission",
        reason: null,
        upstream: "unknown",
        observed: `a host's admission.decide op ended error(${decide.value.reason_code ?? "unclassified"})`,
        facts: [{ text: `admission.decide ended error(${decide.value.reason_code ?? "unclassified"})`, evidence: [decide.id], window: decide.window, absent: null }],
        hypothesis: { text: "the decide call or its retry path lost the answer", falsified_by: "a decided_at on the request row" },
        falsify: { absence: "a decided_at on the request row", attribution: "a decide op for another request" },
      };
    }
    if (decide.claim === "ok" && (decidedAt === null || decidedAt > decide.window.to_ms + decided_proof_ms)) {
      const w = { from_ms: decide.window.from_ms, to_ms: decide.window.to_ms + decided_proof_ms };
      return {
        status: "finding",
        outcome: "broken",
        window: w,
        hop: "admission_decide",
        module: "api.admission",
        reason: null,
        upstream: "unknown",
        observed: "a host's admission.decide op ended ok but no decided_at committed within 5 s",
        facts: [
          { text: "admission.decide ended ok", evidence: [decide.id], window: decide.window, absent: null },
          { text: "no decided_at within 5 s", evidence: [], window: w, absent: "admission.decided_at" },
        ],
        hypothesis: { text: "the decision's commit lost the race or rolled back after the op returned", falsified_by: "a decided_at within 5 s of the op" },
        falsify: { absence: "a decided_at within 5 s", attribution: "a decided_at for a different request" },
      };
    }
  }

  // Host positioning: an in-call host participant, or a dashboard host.
  const hostParticipant = hosts.find(
    (o) =>
      o.value.manage_admission === true &&
      o.claim === "active" &&
      /** @type {number} */ (o.value.joined_at ?? Infinity) <= requestedAt &&
      hosts.some((auth) => auth.source === "sync" && auth.subject.participant === o.subject.participant && auth.window.from_ms <= requestedAt),
  );
  const callPage = hostReads.find((o) => o.source === "client" && o.claim === "shown" && o.window.from_ms < expiresAt && (o.window.to_ms ?? o.window.from_ms + host_visible_ms) - Math.max(o.window.from_ms, requestedAt) >= host_visible_ms);
  const edgeReads = callStatusCadence(hostReads, requestedAt, expiresAt);
  const positioned = hostParticipant ?? callPage ?? (edgeReads ? hostReads.find((o) => o.source === "edge") : undefined);

  if (!positioned) {
    const edgeCovered = hostReads.some((o) => o.source === "edge") || readings["admission.host_reads"].kind === "absent";
    if (!edgeCovered) return { status: "unknown", reason: "edge unavailable" };
    return {
      status: "finding",
      outcome: "expected",
      window: knockWindow,
      hop: null,
      module: null,
      reason: "admission.no_host",
      upstream: "witnessed",
      observed: "no host was positioned during the knock's window",
      facts: [{ text: "no positioned host in db, sync or edge", evidence: [], window: knockWindow, absent: "admission.host" }],
      hypothesis: null,
      falsify: { absence: null, attribution: "a manageAdmission Participant active through the window, or a dashboard host's reads" },
    };
  }

  // A knock surface for this request shown to that host within 10 s of the request reaching room state.
  const reached = rows.find((o) => o.source === "sync")?.window.from_ms ?? requestedAt;
  const shown = knocks.find(
    (o) =>
      o.claim === "shown" &&
      o.window.from_ms >= reached - knock_shown_ms &&
      o.window.from_ms <= reached + knock_shown_ms &&
      (requestKey(o) === handle || requestKey(o) === undefined || positioned.subject.participant === o.subject.participant || positioned.value.user_id === o.value.user_id),
  );
  if (!shown) {
    const hostLabel = positioned.subject.participant ? `pt_${String(positioned.subject.participant).slice(0, 4)}` : `usr_${String(positioned.value.user_id ?? "?").slice(0, 4)}`;
    const dashboard = positioned.source === "edge" || (callPage !== undefined && positioned === callPage);
    const w = { from_ms: reached, to_ms: reached + knock_shown_ms };
    const facts = [
      { text: `knock ${row.claim === "pending" ? "pending then expired" : row.claim}`, evidence: [row.id], window: knockWindow, absent: null },
      { text: "admission_requested reached room state", evidence: rows.filter((o) => o.source === "sync").map((o) => o.id), window: w, absent: null },
      { text: `${hostLabel} ${callPage !== undefined && positioned === callPage ? "call page shown and visible" : positioned.source === "edge" ? "call-status reads kept the window" : "positioned in the Episode"}`, evidence: [positioned.id], window: positioned.window, absent: null },
      { text: `no knock surface shown to ${hostLabel} within 10 s`, evidence: [], window: w, absent: "admission.knock_shown" },
    ];
    return {
      status: "finding",
      outcome: "broken",
      window: w,
      hop: dashboard ? "dashboard_read" : "knock_notice",
      module: dashboard ? "web.dashboard" : "react.admission",
      reason: null,
      upstream: "witnessed",
      observed: "a host was positioned but no knock surface was shown to it within 10 s",
      facts,
      hypothesis: { text: dashboard ? "the dashboard's call-status reads dropped or rewrote the knock list" : "the host's client never rendered the notice", falsified_by: "a knock surface for the request shown to that host within 10 s" },
      falsify: { absence: "a knock surface for the request shown to that host within 10 s", attribution: "a surface for a different request or a different host" },
    };
  }

  // Shown long enough and never answered.
  const seen = (shown.window.to_ms ?? shown.window.from_ms + knock_seen_ms) - shown.window.from_ms >= knock_seen_ms;
  if (seen && !decide) {
    return {
      status: "finding",
      outcome: "expected",
      window: knockWindow,
      hop: null,
      module: null,
      reason: "admission.seen_unanswered",
      upstream: "witnessed",
      observed: "a knock surface was shown to a host for at least 5 s and no admission.decide op began",
      facts: [{ text: "knock surface shown to the host", evidence: [shown.id], window: shown.window, absent: null }],
      hypothesis: null,
      falsify: { absence: null, attribution: "an admission.decide op for the request" },
    };
  }
  return { status: "pass" };
}
