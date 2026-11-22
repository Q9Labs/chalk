// @ts-check
/**
 * admission.unresolved: a join attempt (keyed by its client session) that never got an admission decision, including one that
 * never became an Episode.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "admission.unresolved";

export const expected = "every join attempt ends in an admission decision (admitted or refused with a reason)";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = () => true;

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const decision = readings["admission.decision"];
  if (decision.kind !== "absent") return decision.kind === "present" ? { status: "pass" } : { status: "unknown", reason: "admission decisions not read" };
  return {
    status: "finding",
    outcome: "broken",
    window,
    hop: "api_admission",
    module: "api.admission",
    reason: null,
    upstream: "unknown",
    observed: "the attempt never got an admission decision",
    facts: [{ text: "no admission decision", evidence: [], window, absent: "admission.decision" }],
    hypothesis: null,
    falsify: { absence: "an admission decision row for this journey", attribution: null },
  };
}
