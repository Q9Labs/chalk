// @ts-check

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */

export const symptom = "access.connection_lost";
export const expected = "the entered seat has an explicit usable-grant check and no witnessed grant failure";

/** @param {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} declaration @param {import("../../scripts/diagnose-call/proof/profile.mjs").Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null;

/** @param {DecideInput} input @returns {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} */
export function decide({ readings }) {
  const grant = readings["access.grant_check"];
  const failure = failureIn(grant);
  if (failure) {
    const observed = failure.claim === "expired" ? "access expired before it could be renewed and the SDK failed the connection" : "access was invalid and the SDK failed the connection";
    return finding(failure, "broken", "access_refresh", observed, "a usable grant was installed before that same failure settled");
  }
  return verified(grant) ? { status: "pass" } : { status: "unknown", reason: "no covered, usable-grant checkpoint after the last retry" };
}

// Shared by the continuity rules. It lives in a registered rule so changes invalidate saved verdicts.
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Reading} Reading */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

/** @param {Reading} reading */
export const failureIn = (reading) => (reading.kind === "present" ? reading.observations.find((row) => row.failure) : undefined);

/**
 * An unresolved checkpoint is cleared by a later good one. Compare sequence within a source, and disjoint clock windows across sources.
 * An open tail, missing checkpoint or proven absence is never a positive observation.
 * @param {Reading} reading
 */
export function verified(reading) {
  if (reading.kind !== "present" || !reading.complete) return false;
  return reading.observations.some((row) => row.claim === "verified" && reading.observations.every((other) => other.claim === "verified" || earlier(other, row)));
}

/**
 * @param {Observation} row
 * @param {"broken" | "degraded"} outcome
 * @param {string} hop
 * @param {string} observed
 * @param {string} attribution
 * @returns {Decision}
 */
export function finding(row, outcome, hop, observed, attribution) {
  return {
    status: "finding",
    outcome,
    window: row.window,
    hop,
    module: "sdk.connection",
    reason: null,
    upstream: "unknown",
    observed,
    facts: [{ text: observed, evidence: [row.id], window: row.window, absent: null }],
    hypothesis: null,
    falsify: { absence: null, attribution },
  };
}

/** @param {Observation} first @param {Observation} second */
function earlier(first, second) {
  const a = first.value.seq;
  const b = second.value.seq;
  return first.origin !== "measured:client" && first.origin === second.origin && typeof a === "number" && typeof b === "number" ? a < b : first.window.to_ms < second.window.from_ms;
}
