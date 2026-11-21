// @ts-check
/**
 * recording.capture_failed: a capture job that spent at least one attempt and ended terminal_failure for any
 * cause but capture_empty. A lease that expired with no capture_finished names a worker that disappeared.
 * The db terminal proves the failure; recorder rows fill the attempt account, so none is a gap, not healthy.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

import { PASS, broken, captureJob, fact, field, jobRow, obs, unknown } from "./recording.shared.mjs";

export const symptom = "recording.capture_failed";
export const expected = "a claimed capture attempt either finishes or fails retryable until its limit, never silently";
export const settle_ms = 60_000;


export const applies = captureJob;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const job = jobRow(readings);
  if (!job) return unknown("the job row is not witnessed");
  const attempts = field(job, "recording_attempt_count", 0);
  const code = field(job, "recording_error_code", "");
  if (job.claim !== "terminal_failure" && job.claim !== "cancelled") {
    if (job.claim === "leased" && field(job, "recording_lease_expiry_ms", Infinity) < job.window.to_ms) {
      const results = obs(readings["recording.capture_result"]);
      if (readings["recording.capture_result"]?.kind === "unknown") return unknown("the recorder's account is not read");
      if (!results.length && attempts > 0) {
        return broken({
          hop: "capture_attempt",
          module: "recorder.capture",
          observed: `lease expired at ${field(job, "recording_lease_expiry_ms", 0)} with no capture_finished for ${attempts} attempt(s): the worker disappeared`,
          facts: [fact(`job leased, lease_expires_at=${field(job, "recording_lease_expiry_ms", 0)}`, [job]), fact("no capture_finished for the leased attempt", [], "the recorder's summary is absent")],
          at: field(job, "recording_lease_expiry_ms", job.window.to_ms),
          evidence: [job],
        });
      }
    }
    return PASS;
  }
  if (attempts === 0) return PASS; // never_captured's call
  if (code === "capture_empty") return PASS; // recording.empty's call
  const failures = obs(readings["recording.attempts"]);
  const at = field(job, "recording_terminal_ms", job.window.to_ms);
  return broken({
    hop: "capture_attempt",
    module: "recorder.capture",
    observed: `job terminal_failure after ${attempts} attempt(s), error_code=${code || "none"}`,
    facts: [
      fact(`job terminal_failure error_code=${code || "none"} attempt=${attempts}/${field(job, "recording_attempt_limit", 0)}`, [job]),
      ...failures.map((o) => fact(`attempt ${field(o, "recording_attempt", 0)} failed: ${o.claim}`, [o])),
    ],
    at,
    evidence: [job, ...failures],
  });
}
