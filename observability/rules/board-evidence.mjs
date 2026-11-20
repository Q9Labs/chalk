// @ts-check

/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Reading} Reading */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").FindingDecision} FindingDecision */

/** @param {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} declaration @param {import("../../scripts/diagnose-call/proof/profile.mjs").Seat | null} seat */
export const applies = (declaration, seat) => declaration.kind === "episode" && declaration.features.includes("board") && seat !== null;

/** @param {Reading | undefined} reading */
export const rows = (reading) => (reading?.kind === "present" ? reading.observations : []);

/** @param {Observation} row */
export const correlation = (row) => row.value.board_correlation_id;

/** @param {Observation} row */
export const scene = (row) => row.value.board_scene_id;

/** @param {Observation} row */
export const revision = (row) => row.value.board_revision;

/** @param {Observation} a @param {Observation} b */
export const sameRevision = (a, b) => typeof scene(a) === "string" && typeof revision(a) === "string" && scene(a) === scene(b) && revision(a) === revision(b);

/**
 * @param {Observation} row
 * @param {string} hop
 * @param {string} observed
 * @param {string} falsifier
 * @param {{ row: Observation, text: string } | null} upstream
 * @param {string | null} [reason]
 * @returns {FindingDecision}
 */
export function finding(row, hop, observed, falsifier, upstream, reason = null) {
  const facts = [{ text: observed, evidence: [row.id], window: row.window, absent: null }];
  if (upstream) facts.push({ text: upstream.text, evidence: [upstream.row.id], window: upstream.row.window, absent: null });
  return {
    status: "finding",
    outcome: reason ? "expected" : "broken",
    window: row.window,
    hop,
    module: "sdk.whiteboard",
    reason,
    upstream: upstream ? "witnessed" : "unknown",
    observed,
    facts,
    hypothesis: null,
    falsify: { absence: null, attribution: falsifier },
  };
}
