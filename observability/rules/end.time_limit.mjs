// @ts-check

export const symptom = "end.time_limit";
export const expected = "the authoritative end distinguishes a maximum-duration end from other Episode ends";

/** @param {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} declaration */
export const applies = (declaration) => declaration.kind === "episode" && declaration.window.to_ms !== null;

/**
 * @param {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} input
 * @returns {import("../../scripts/diagnose-call/proof/profile.mjs").Decision}
 */
export function decide({ readings }) {
  const end = readings["end.episode"];
  if (end.kind !== "present") return { status: "unknown", reason: "the authoritative Episode end is not witnessed" };
  const [server] = end.observations;
  if (server.claim !== "maximum_duration") return { status: "pass" };
  return {
    status: "finding",
    outcome: "expected",
    reason: symptom,
    window: server.window,
    hop: null,
    module: null,
    upstream: null,
    observed: "the Episode reached its maximum duration",
    facts: [{ text: "the authoritative end reason was maximum_duration", evidence: [server.id], window: server.window, absent: null }],
    hypothesis: null,
    falsify: { absence: null, attribution: "the finalized Episode carries a different reason" },
  };
}
