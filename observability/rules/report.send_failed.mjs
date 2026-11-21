// @ts-check
/**
 * report.send_failed: the person pressed Send report and saw "Your report could not be sent".
 *
 * The witnesses are in areas/report.json: the client's `report.dialog` send_failed surface and `problem_report.send` op (one
 * witness: both are the client's own observation), the API's `problem_report.submit` decision and `problem_report.outcome` cause
 * (one witness with the stored `report.problem` row, which the same commit wrote). A send_failed surface with no stored row and no
 * api answer means the request never reached the API: hop client_network. A refused commit names the api; a stored row against the
 * error surface names the client (the answer got lost after the commit). The quota refusals a Participant or an Episode earns are
 * expected, never broken.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "report.send_failed";

/** Long enough for a refused or stored commit to reach the api reading after the send. */
const SETTLE_MS = 15_000;
/** The window before the send that counts an earlier report toward the per-Participant quota. */
const PARTICIPANT_QUOTA_WINDOW_MS = 3_600_000;
const PARTICIPANT_QUOTA_COUNT = 3;
const EPISODE_QUOTA_COUNT = 20;

export const settle_ms = SETTLE_MS;

export const healthy_absent = ["report.dialog", "report.send", "report.submit", "report.outcome", "report.problem"];

export const expected = "pressing Send report stores the row and answers sent with a CHK code; a refusal only comes from the Participant or Episode report quota";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/** @param {Observation} o */
const journeyOf = (o) => (typeof o.value.journey_id === "string" ? o.value.journey_id : null);

/** Whether the reading proves nothing for journey jr exists: proven absent, or a complete present with no matching row. */
const coversFor = (reading, jr) => reading.kind === "absent" || (reading.kind === "present" && reading.complete === true && !reading.observations.some((o) => journeyOf(o) === jr));

/** @param {Observation[]} rows @param {string} jr */
const forJourney = (rows, jr) => rows.filter((o) => journeyOf(o) === jr);

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings }) {
  const dialog = readings["report.dialog"];
  const send = readings["report.send"];
  const submit = readings["report.submit"];
  const outcome = readings["report.outcome"];
  const problem = readings["report.problem"];

  if (dialog.kind === "unknown") return { status: "unknown", reason: "the seat's dialog evidence is incomplete" };
  if (dialog.kind === "absent") return { status: "pass" };
  const failed = dialog.observations.filter((o) => o.claim === "send_failed");
  if (failed.length === 0) return { status: "pass" };
  if (problem.kind === "unknown") return { status: "unknown", reason: "the report source is not read" };
  if (submit.kind === "unknown") return { status: "unknown", reason: "the api decisions are not complete to the send" };
  if (outcome.kind === "unknown") return { status: "unknown", reason: "the api outcomes are not complete to the send" };

  const sendRows = send.kind === "present" ? send.observations : [];
  const reports = problem.kind === "present" ? problem.observations : [];
  const submits = submit.kind === "present" ? submit.observations : [];
  const outcomes = outcome.kind === "present" ? outcome.observations : [];

  const surface = [...failed].sort((a, b) => a.window.from_ms - b.window.from_ms)[0];
  const jr = journeyOf(surface) ?? journeyOf(sendRows[0] ?? surface);
  const sendOp = sendRows.find((o) => journeyOf(o) === jr) ?? sendRows[0];
  const sendAt = sendOp?.window.from_ms ?? surface.window.from_ms;

  if (jr !== null && reports.some((o) => journeyOf(o) === jr)) {
    const row = reports.find((o) => journeyOf(o) === jr);
    return finding(surface, sendAt, "client_ui", "web.problem_reports", "unknown", [
      { text: `the client showed send_failed for ${jr}`, evidence: [surface.id], window: surface.window, absent: null },
      { text: `a problem_reports row for ${jr} exists (stored_but_failed)`, evidence: [row.id], window: row.window, absent: null },
    ], "the API stored the report but the answer never reached the client", "the client's send op ending ok for this journey");
  }

  const refused = submits.find((o) => journeyOf(o) === jr && o.claim === "refused");
  const outcomeRow = outcomes.find((o) => journeyOf(o) === jr);
  const cause = refused ? String(refused.value.reason_code ?? "refused") : outcomeRow ? String(outcomeRow.claim) : null;
  if ((refused !== undefined || outcomeRow !== undefined) && cause !== null) {
    const quota = quotaExpected(cause, reports, surface, sendAt);
    if (quota !== null) {
      return {
        status: "finding",
        outcome: "expected",
        window: surface.window,
        hop: null,
        module: null,
        reason: quota,
        upstream: null,
        observed: `the send for ${jr} was refused ${cause}, inside the quota it already earned`,
        facts: [
          { text: `the client showed send_failed for ${jr}`, evidence: [surface.id], window: surface.window, absent: null },
          { text: `problem_report.outcome cause ${cause}`, evidence: [(refused ?? outcomeRow).id], window: (refused ?? outcomeRow).window, absent: null },
        ],
        hypothesis: null,
        falsify: { absence: null, attribution: `fewer than ${PARTICIPANT_QUOTA_COUNT} earlier reports for the seat in the hour before the send` },
      };
    }
    return finding(surface, sendAt, "api", "api.problemreports", "unknown", [
      { text: `the client showed send_failed for ${jr}`, evidence: [surface.id], window: surface.window, absent: null },
      { text: `problem_report.submit refused ${cause} for ${jr}`, evidence: [(refused ?? outcomeRow).id], window: (refused ?? outcomeRow).window, absent: null },
      { text: `no problem_reports row for ${jr}`, evidence: [], window: null, absent: "report.problem" },
    ]);
  }

  const apiCovers = coversFor(submit, jr ?? "") && coversFor(outcome, jr ?? "");
  if (!apiCovers) return { status: "unknown", reason: "the api readings are not complete to the send plus 15 s" };
  if (problem.kind !== "absent" && jr !== null && !reports.some((o) => journeyOf(o) === jr) && problem.kind === "present" && problem.complete !== true) {
    return { status: "unknown", reason: "the report source is not complete to the send" };
  }
  const errClass = sendOp ? `error(${sendErrorClass(sendOp)})` : "no answer";
  return {
    ...finding(surface, sendAt, "client_network", "network", "witnessed", [
      { text: `problem_report.send ${errClass} for ${jr}`, evidence: [sendOp?.id ?? surface.id], window: sendOp?.window ?? surface.window, absent: null },
      { text: `no api decision for ${jr}`, evidence: [], window: null, absent: "report.submit" },
    ], "the request was blocked before the API", `any api or edge row for ${jr}`),
    hypothesis: { text: "blocked before the API", falsified_by: `any api or edge row for ${jr}` },
  };
}

/** @param {Observation} o */
function sendErrorClass(o) {
  const code = o.value.reason_code;
  if (code === "report.send_refused" && typeof o.value.http_status === "number") return `http_${o.value.http_status}`;
  if (code === "report.timeout") return "timeout";
  if (code === "report.network") return "network";
  if (code === "report.no_credential") return "no_credential";
  return typeof code === "string" ? code : "error";
}

/** The quota expecteds, or null. @param {string} cause @param {Observation[]} reports @param {Observation} surface @param {number} sendAt */
function quotaExpected(cause, reports, surface, sendAt) {
  if (cause === "participant_quota") {
    const earlier = reports.filter((o) => o.subject.participant === surface.subject.participant && o.window.from_ms >= sendAt - PARTICIPANT_QUOTA_WINDOW_MS && o.window.from_ms < sendAt);
    return earlier.length >= PARTICIPANT_QUOTA_COUNT ? "report.participant_quota" : null;
  }
  if (cause === "episode_quota") {
    const earlier = reports.filter((o) => o.window.from_ms >= sendAt - PARTICIPANT_QUOTA_WINDOW_MS && o.window.from_ms < sendAt);
    return earlier.length >= EPISODE_QUOTA_COUNT ? "report.episode_quota" : null;
  }
  return null;
}

/** @param {Observation} surface @param {number} at @param {string} hop @param {string} module @param {"witnessed"|"unknown"|null} upstream @param {import("../../scripts/diagnose-call/proof/profile.mjs").Fact[]} facts @param {string} observed @param {string} falsifiedBy */
function finding(surface, at, hop, module, upstream, facts, observed, falsifiedBy) {
  return {
    status: "finding",
    outcome: "broken",
    window: surface.window,
    hop,
    module,
    reason: null,
    upstream,
    observed,
    facts,
    hypothesis: null,
    falsify: { absence: null, attribution: falsifiedBy },
  };
}
