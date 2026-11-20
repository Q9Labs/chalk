// @ts-check

export const symptom = "rejoin.refused";
export const expected = "an explicit Rejoin releases the previous arrival before starting another";
export const settle_ms = 120_000;

/**
 * @param {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} declaration
 * @param {import("../../scripts/diagnose-call/proof/profile.mjs").Seat | null} seat
 */
export const applies = (declaration, seat) => declaration.kind === "episode" && seat !== null && seat.window.to_ms !== null && (declaration.window.to_ms === null || seat.window.to_ms < declaration.window.to_ms);

/**
 * @param {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} input
 * @returns {import("../../scripts/diagnose-call/proof/profile.mjs").Decision}
 */
export function decide({ readings }) {
  const release = readings["rejoin.release"];
  if (release.kind !== "present") return { status: "unknown", reason: "no explicit Rejoin release was witnessed for this seat" };
  const failed = release.observations.find((event) => event.claim === "release_failed");
  if (!failed) return { status: "pass" };
  return {
    status: "finding",
    outcome: "broken",
    window: failed.window,
    hop: "release",
    module: "web.space_entry",
    reason: null,
    upstream: "unknown",
    observed: "the prior arrival could not be released before Rejoin",
    facts: [{ text: "the app recorded a failed release on Rejoin", evidence: [failed.id], window: failed.window, absent: null }],
    hypothesis: null,
    falsify: { absence: null, attribution: "the release result belongs to ordinary cleanup, not an explicit Rejoin" },
  };
}
