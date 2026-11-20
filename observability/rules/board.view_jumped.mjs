// @ts-check
/**
 * board.view_jumped: a viewer's board camera jumping. Its witness is one older builds cannot emit, so its absence is unknown,
 * never "board unused".
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Seat} Seat */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */

export const symptom = "board.view_jumped";

/** More automatic camera moves than this within two seconds is a jumping view. */
const JUMPS_PER_2S = 5;

export const expected = `a viewer's board camera moves automatically at most ${JUMPS_PER_2S} times in any 2 s`;

/** @param {Declaration} declaration @param {Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && declaration.features.includes("board") && seat !== null;

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings }) {
  const camera = readings["board.camera"];
  if (camera.kind === "unknown") return { status: "unknown", reason: "viewer camera evidence not witnessed" };
  const automatic = camera.kind === "present" ? camera.observations.filter((o) => o.claim !== "user_pan").sort((a, b) => a.window.from_ms - b.window.from_ms) : [];
  for (let start = 0; start + JUMPS_PER_2S < automatic.length; start += 1) {
    const burst = automatic.slice(start, start + JUMPS_PER_2S + 1);
    const window = { from_ms: burst[0].window.from_ms, to_ms: /** @type {Readonly<Observation>} */ (burst.at(-1)).window.to_ms };
    if (window.to_ms - window.from_ms > 2_000) continue;
    return {
      status: "finding",
      outcome: "degraded",
      window,
      hop: "board_follow",
      module: "sdk.board",
      reason: null,
      upstream: "witnessed",
      observed: `${burst.length} automatic camera moves within 2 s`,
      facts: [{ text: `${burst.length} automatic camera moves (${[...new Set(burst.map((o) => o.claim))].join(", ")})`, evidence: burst.map((o) => o.id), window, absent: null }],
      hypothesis: null,
      falsify: { absence: null, attribution: "the moves were caused by the viewer (user_pan)" },
    };
  }
  return { status: "pass" };
}
