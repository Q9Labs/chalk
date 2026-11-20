// @ts-check
/**
 * Compare the authoritative Episode end and the SDK's terminal classification.
 * A status-only confirmation can select the generic screen; it cannot claim the specific Sync reason.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "end.wrong_screen";

const FAILURE_SCREENS = new Set(["connection_lost", "join_failed"]);
/** Media is revoked as part of ending, so a client can fail a little before the end commits. */
const BEFORE_MS = 10_000;
/** A client that loses the end notice keeps going until its own recovery gives up. */
const AFTER_MS = 120_000;

/** Records about the end arrive after it, so the check reads this far past the Episode's end. */
export const settle_ms = AFTER_MS;

export const expected = "the SDK classifies the authoritative Episode end without a connection failure and preserves a known time limit";

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && declaration.window.to_ms !== null && seat !== null && (seat.window.to_ms === null || seat.window.to_ms >= declaration.window.to_ms - BEFORE_MS);

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings }) {
  const end = readings["end.episode"];
  const screen = readings["end.client_screen"];
  if (end.kind !== "present") return { status: "unknown", reason: "the Episode's end is not witnessed" };
  const [server] = end.observations;
  if (screen.kind !== "present") return { status: "unknown", reason: "the seat's terminal classification is not witnessed" };
  const at = server.window.from_ms;
  const nearEnd = screen.observations.filter((o) => o.window.to_ms >= at - BEFORE_MS && o.window.from_ms <= at + AFTER_MS);
  if (nearEnd.length === 0) return { status: "unknown", reason: "no terminal classification is timed near the Episode end" };
  const wrong = nearEnd.find((o) => FAILURE_SCREENS.has(o.claim) || (server.claim === "maximum_duration" && o.value.episode_end_reason === "maximum_duration" && o.claim === "episode_ended"));
  if (!wrong) {
    // Legacy rows can't tell a status-only confirmation from a client that knew the reason but lost it.
    if (server.claim === "maximum_duration" && nearEnd.some((o) => o.claim === "episode_ended")) {
      return { status: "unknown", reason: "the generic end does not establish whether the client knew the time limit" };
    }
    return { status: "pass" };
  }
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: Math.min(at, wrong.window.from_ms), to_ms: Math.max(at, wrong.window.to_ms) },
    hop: "client_end",
    module: "sdk.connection",
    reason: null,
    upstream: "witnessed",
    observed: `the Episode ended (${server.claim}) and the client showed ${wrong.claim}`,
    facts: [
      { text: `Sync saw the Episode end: ${server.claim}`, evidence: [server.id], window: server.window, absent: null },
      { text: `the client showed the ${wrong.claim} screen`, evidence: [wrong.id], window: wrong.window, absent: null },
    ],
    hypothesis: null,
    falsify: { absence: null, attribution: "the SDK classified the end correctly for the reason it knew, or the failure was outside the end window" },
  };
}
