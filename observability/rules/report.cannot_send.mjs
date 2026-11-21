// @ts-check
/**
 * report.cannot_send: the report dialog was open but blocked sending for at least a second.
 *
 * The witnesses are in areas/report.json: the client's `report.dialog` surface (blocked with a machine-readable reason from the
 * unavailableCode prop, never the text), the db `report.seat` row (the seat's left_at, independent of the client) and the api
 * `report.availability` decisions (which hop a reports_unavailable block belongs to). A block on an expired credential more than
 * a day after the seat left is expected: the report window had closed.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "report.cannot_send";

/** A blocked surface must be shown this long to count: shorter blocks are normal flow. */
const BLOCKED_MS = 1_000;
/** An availability decision this old still explains a blocked dialog. */
const AVAIL_BEFORE_MS = 60_000;
/** A credential-expired block more than this long after the seat left is the closed report window, not a fault. */
const AFTER_LEAVE_MS = 24 * 3_600_000;

/** The credential expiry waits five minutes after the seat leaves; a margin covers the post-leave client tail. */
export const settle_ms = 600_000;

export const healthy_absent = ["report.dialog", "report.availability"];

export const expected = "the report dialog always lets the person send: a credential-expired block only inside 24 hours of leaving, and reports_unavailable only when the API says reports are off";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings }) {
  const dialog = readings["report.dialog"];
  if (dialog.kind === "unknown") return { status: "unknown", reason: "the seat's dialog evidence is incomplete" };
  if (dialog.kind === "absent") return { status: "pass" };

  // A dismissed surface carries its shown_ms; a still-open shown surface counts from its stamp, err side toward longer.
  const blocked = dialog.observations
    .filter((o) => o.claim === "blocked")
    .map((o) => {
      if (o.value.surface_state === "dismissed" && typeof o.value.shown_ms === "number") {
        return { o, shown_ms: o.value.shown_ms, shown_at: o.window.to_ms - o.value.shown_ms };
      }
      if (o.value.surface_state === "shown") {
        return { o, shown_ms: null, shown_at: o.window.from_ms };
      }
      return null;
    })
    .filter((b) => b !== null && (b.shown_ms === null ? b.o.window.to_ms - b.shown_at >= BLOCKED_MS : b.shown_ms >= BLOCKED_MS));
  if (blocked.length === 0) return { status: "pass" };

  const { o: surface, shown_at } = blocked.sort((a, b) => a.shown_at - b.shown_at)[0];
  const reason = typeof surface.value.blocked_reason === "string" ? surface.value.blocked_reason : "unavailable";

  if (reason === "credential_expired") {
    const seat = readings["report.seat"];
    if (seat.kind === "unknown") return { status: "unknown", reason: "the credential_expired evidence needs the seat's left_at and the db is not read" };
    const left = seat.kind === "present" ? seat.observations.find((o) => typeof o.value.seat_left_ms === "number") : undefined;
    if (left !== undefined && shown_at - Number(left.value.seat_left_ms) > AFTER_LEAVE_MS) {
      return {
        status: "finding",
        outcome: "expected",
        window: { from_ms: shown_at, to_ms: surface.window.to_ms },
        hop: null,
        module: null,
        reason: "report.after_leave_window",
        upstream: null,
        observed: "the credential expired more than a day after the seat left, so the report window had closed",
        facts: [
          { text: `report.dialog blocked credential_expired for ${Math.round((surface.window.to_ms - shown_at) / 1000)} s`, evidence: [surface.id], window: { from_ms: shown_at, to_ms: surface.window.to_ms }, absent: null },
          { text: "the seat had left over 24 hours before", evidence: [left.id], window: left.window, absent: null },
        ],
        hypothesis: null,
        falsify: { absence: null, attribution: "a blocked dialog within 24 hours of the seat leaving" },
      };
    }
    return broken(surface, shown_at, "client_ui", "web.problem_reports", `blocked credential_expired for ${Math.round((surface.window.to_ms - shown_at) / 1000)} s`);
  }

  const availability = readings["report.availability"];
  if (availability.kind === "present") {
    const refused = availability.observations.some((o) => o.claim === "false" && o.window.to_ms >= shown_at - AVAIL_BEFORE_MS && o.window.from_ms <= shown_at);
    if (refused) return broken(surface, shown_at, "api", "api.problemreports", `blocked reports_unavailable; the api availability decision was false`, availability.observations.filter((o) => o.claim === "false")[0]);
  }
  return broken(surface, shown_at, "client_ui", "web.problem_reports", `blocked ${reason} for ${Math.round((surface.window.to_ms - shown_at) / 1000)} s`);
}

/** @param {Observation} surface @param {number} shownAt @param {string} hop @param {string} module @param {string} observed @param {Observation} [cite] */
function broken(surface, shownAt, hop, module, observed, cite) {
  const facts = [
    { text: `report.dialog ${observed}`, evidence: [surface.id], window: { from_ms: shownAt, to_ms: surface.window.to_ms }, absent: null },
  ];
  if (cite !== undefined) facts.push({ text: "problem_report.availability decided false", evidence: [cite.id], window: cite.window, absent: null });
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: shownAt, to_ms: surface.window.to_ms },
    hop,
    module,
    reason: null,
    upstream: "unknown",
    observed,
    facts,
    hypothesis: null,
    falsify: { absence: null, attribution: "a dialog that lets the person send" },
  };
}
