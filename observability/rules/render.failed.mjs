// @ts-check
/**
 * render.failed: a render job that reached terminal_failure. The stage-scoped error code
 * (render_<stage>_failed) names the hop; a bundle 404 on the download_capture stage names
 * storage.r2, and render.source_expired when the bundle's retention lapsed. Without recorder
 * stage rows the db code still proves the failure — the gap says what was not read.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

import { PASS, broken, expectedFinding, fact, field, jobRow, obs, renderJob, unknown } from "./recording.shared.mjs";

export const symptom = "render.failed";
export const expected = "every render stage completes, or names the stage it failed in and whether storage still had the bundle";
export const settle_ms = 60_000;

export const applies = renderJob;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const job = jobRow(readings);
  if (!job) return unknown("the job row is not witnessed");
  if (job.claim !== "terminal_failure") return PASS;
  const code = field(job, "recording_error_code", "");
  const stage = /^render_([a-z_]+)_failed$/.exec(code)?.[1] ?? field(obs(readings["recording.render_result"]).find((o) => field(o, "recording_stage", null) !== null), "recording_stage", null);
  const heads = obs(readings["recording.bundle_head"]);
  const missing = heads.filter((o) => o.claim === "not_found");
  const at = field(job, "recording_terminal_ms", job.window.to_ms);
  const hop = stage ? `render_${stage}` : "render";
  const facts = [
    fact(`job terminal_failure error_code=${code || "none"} attempt=${field(job, "recording_attempt_count", 0)}/${field(job, "recording_attempt_limit", 0)}`, [job]),
    ...obs(readings["recording.render_result"]).filter((o) => o.claim !== "ok").map((o) => fact(`render stage ${field(o, "recording_stage", "?")} ${o.claim}${field(o, "reason_code", null) ? ` (${field(o, "reason_code", "")})` : ""}`, [o])),
    ...missing.map((o) => fact(`bundle ${field(o, "recording_bundle_sequence", "?")} HEAD not_found`, [o])),
  ];
  if (stage === "download_capture" && missing.length) {
    return broken({
      hop,
      module: "storage.r2",
      observed: `${code}: ${missing.length} committed bundle object(s) are not in R2`,
      facts,
      at,
      evidence: [job, ...missing],
    });
  }
  if (stage === "download_capture" && heads.length && !missing.length) {
    return expectedFinding({
      hop,
      module: "storage.r2",
      reason: "render.source_expired",
      observed: `${code} and every committed bundle HEAD resolves: the capture source outlived its retention`,
      facts,
      at,
      evidence: [job, ...heads],
    });
  }
  return broken({
    hop,
    module: "recorder.render",
    observed: `${code || "render failed"} at ${hop}`,
    facts,
    at,
    evidence: [job, ...heads],
  });
}
