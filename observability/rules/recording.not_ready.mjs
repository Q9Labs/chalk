// @ts-check
/**
 * recording.not_ready: a post-call recording job that failed, or is still pending long after the Episode ended.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

/** @param {Readonly<Observation>} o */
const cite = (o) => [o.id];

export const symptom = "recording.not_ready";

/** A recording still not ready this long after the Episode ended is late. */
const RECORDING_READY_MS = 30 * 60_000;

export const expected = `a recording job reaches a terminal state within ${RECORDING_READY_MS / 60_000} min, and the state is succeeded`;

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "job" && declaration.job_kind === "recording";

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const terminal = readings["recording.job_state"];
  if (terminal.kind === "unknown") return { status: "unknown", reason: "job state not read" };
  if (terminal.kind === "present") {
    const failed = terminal.observations.find((o) => o.claim !== "succeeded");
    if (!failed) return { status: "pass" };
    return {
      status: "finding",
      outcome: "broken",
      window: failed.window,
      hop: "recorder",
      module: "recorder.job",
      reason: null,
      upstream: "unknown",
      observed: `job ended ${failed.claim}`,
      facts: [{ text: `job ended ${failed.claim}`, evidence: cite(failed), window: failed.window, absent: null }],
      hypothesis: null,
      falsify: { absence: null, attribution: "a later succeeded state for the same job" },
    };
  }
  if (window.to_ms - window.from_ms <= RECORDING_READY_MS) return { status: "unknown", reason: `pending for less than ${RECORDING_READY_MS / 60_000} min` };
  return {
    status: "finding",
    outcome: "degraded",
    window,
    hop: "recorder",
    module: "recorder.job",
    reason: null,
    upstream: "unknown",
    observed: `no terminal state ${Math.round((window.to_ms - window.from_ms) / 60_000)} min after the Episode ended`,
    facts: [{ text: "no terminal job state", evidence: [], window, absent: "recording.job_state" }],
    hypothesis: null,
    falsify: { absence: "a terminal state row for the job inside the window", attribution: null },
  };
}
