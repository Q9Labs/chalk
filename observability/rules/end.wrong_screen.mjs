// @ts-check
/**
 * end.wrong_screen: the Episode ended for an authoritative reason, but a seat's client chose a failure end screen (connection lost
 * or join failed) instead of the Episode-ended screen.
 *
 * The witnesses are in areas/end.json: `end.episode` from Sync (sync.episode.ended) and `end.client_screen` from the seat's client
 * (client.call_ended). A client screen counts when its time, widened by the row's clock error, falls in a window around the end. A
 * seat passes only when both witnesses are present and its client showed the Episode-ended screen (episode_ended or time_limit) in
 * that window, none of them a failure screen: an end nobody witnessed, or a seat whose client left, was removed or closed its page
 * without showing that screen, is unknown, never healthy. A client row with no server time can't
 * be placed, so the adapter drops it and the seat stays unchecked. A seat that left well before the end never sees the end screen,
 * so the check does not apply to it.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "end.wrong_screen";

const FAILURE_SCREENS = new Set(["connection_lost", "join_failed"]);
/** The reasons that mean the client showed the Episode-ended screen. A seat that left, was removed or closed its page saw no end screen. */
const ENDED_SCREENS = new Set(["episode_ended", "time_limit"]);
/** Media is revoked as part of ending, so a client can fail a little before the end commits. */
const BEFORE_MS = 10_000;
/** A client that loses the end notice keeps going until its own recovery gives up. */
const AFTER_MS = 120_000;

/** Records about the end arrive after it, so the check reads this far past the Episode's end. */
export const settle_ms = AFTER_MS;

export const expected = `when the Episode ends, every seat's client shows the Episode-ended screen, and none shows a failure screen from ${BEFORE_MS / 1000} s before the end to ${AFTER_MS / 1000} s after it`;

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => {
  const end = declaration.window.to_ms;
  if (declaration.kind !== "episode" || end === null || seat === null) return false;
  return seat.window.to_ms === null || seat.window.to_ms >= end - BEFORE_MS;
};

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings }) {
  const end = readings["end.episode"];
  const screen = readings["end.client_screen"];
  if (end.kind !== "present") return { status: "unknown", reason: "the Episode's end is not witnessed" };
  if (screen.kind !== "present") return { status: "unknown", reason: "the seat's end screen is not witnessed" };
  const [server] = [...end.observations].sort((a, b) => a.window.from_ms - b.window.from_ms);
  const at = server.window.from_ms;
  const near = screen.observations.filter((o) => o.window.to_ms >= at - BEFORE_MS && o.window.from_ms <= at + AFTER_MS);
  const wrong = near.find((o) => FAILURE_SCREENS.has(o.claim));
  if (!wrong) return near.some((o) => ENDED_SCREENS.has(o.claim)) ? { status: "pass" } : { status: "unknown", reason: "the seat showed no Episode-ended screen around the Episode's end" };
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
    hypothesis: { text: "the client lost the end notice and read a stale Episode status", falsified_by: "an end notice delivered on the seat's Sync connection before the client chose its screen" },
    falsify: { absence: null, attribution: `an Episode-ended screen for this seat, or a failure screen more than ${BEFORE_MS / 1000} s before the end` },
  };
}
