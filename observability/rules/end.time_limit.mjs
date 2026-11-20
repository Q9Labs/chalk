// @ts-check
/**
 * end.time_limit: an item-wide `expected` rule with a tight causal precondition. It claims the client failures within a few
 * seconds of a time-limit end, because the end caused them.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Fact} Fact */

/** @param {Readonly<Observation>} o */
const cite = (o) => [o.id];

export const symptom = "end.time_limit";

/** A client failure this close to a time-limit end is the end itself. */
const END_SLACK_MS = 10_000;

export const expected = "an Episode stopped by its time limit ends by an API decision with reason time_limit, and any client failure within 10 s of that end is the end itself";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration) => declaration.kind === "episode" && declaration.features.includes("time_limit");

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, failures }) {
  const end = readings["end.episode"];
  if (end.kind !== "present") return { status: "pass" };
  const decision = end.observations.find((o) => o.claim === "time_limit");
  if (!decision) return { status: "pass" };
  const at = decision.window.from_ms;
  const near = failures.filter((o) => Math.abs(o.window.from_ms - at) <= END_SLACK_MS);
  /** @type {Fact[]} */
  const facts = [{ text: "API ended the Episode: time_limit", evidence: cite(decision), window: decision.window, absent: null }, ...near.map((o) => ({ text: `${o.fact} ${o.claim}, within ${END_SLACK_MS / 1000} s of the end`, evidence: cite(o), window: o.window, absent: null }))];
  return {
    status: "finding",
    outcome: "expected",
    window: decision.window,
    hop: null,
    module: null,
    reason: "end.time_limit",
    upstream: null,
    observed: `ended by time_limit; ${near.length} client failures within ${END_SLACK_MS / 1000} s claimed by the end`,
    facts,
    hypothesis: null,
    falsify: { absence: null, attribution: `an end decision with another reason, or a failure more than ${END_SLACK_MS / 1000} s from the end` },
  };
}
