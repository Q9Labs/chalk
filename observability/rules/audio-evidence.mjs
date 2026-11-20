// @ts-check
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Observation} Observation */
/** @typedef {import("../../scripts/diagnose-call/proof/evidence.mjs").Reading} Reading */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").FindingDecision} FindingDecision */

/** @param {Reading} reading */
export const records = (reading) => (reading.kind === "present" ? reading.observations : []);

/** @param {Readonly<Observation>} row @param {string} hop @param {string} module @param {string} observed @param {string} falsifier */
export function broken(row, hop, module, observed, falsifier) {
  /** @type {FindingDecision} */
  const finding = {
    status: "finding",
    outcome: "broken",
    hop,
    module,
    observed,
    window: row.window,
    reason: null,
    upstream: "unknown",
    facts: [{ text: observed, evidence: [row.id], window: row.window, absent: null }],
    hypothesis: null,
    falsify: { absence: null, attribution: falsifier },
  };
  return finding;
}

/** @param {Readonly<Observation>} left @param {Readonly<Observation>} right */
export function sameTrack(left, right) {
  const track = left.value.audio_track_key;
  return typeof track === "string" && track !== "" && track === right.value.audio_track_key;
}

/** True only if the flat measurement covers every possible time of the progress measurement. @param {Readonly<Observation>} flat @param {Readonly<Observation>} progress */
export function containsProgress(flat, progress) {
  const flatMs = flat.value.audio_sample_ms;
  const progressMs = progress.value.audio_sample_ms;
  return typeof flatMs === "number" && typeof progressMs === "number" && flatMs > 0 && progressMs > 0 && flat.window.to_ms - flatMs <= progress.window.from_ms - progressMs && flat.window.from_ms >= progress.window.to_ms;
}

/** @param {FindingDecision} decision @param {Readonly<Observation>} upstream @param {string} text */
export function withUpstream(decision, upstream, text) {
  return {
    ...decision,
    upstream: /** @type {const} */ ("witnessed"),
    facts: [...decision.facts, { text, evidence: [upstream.id], window: upstream.window, absent: null }],
  };
}
