// @ts-check
/**
 * recording.missing_span: a capture the db says was claimed, with a provably missing span —
 * a claim lag past the bound (30s colocated, 180s fleet), a failed attempt followed by a later claim,
 * or capture completeness partial. Degraded, never broken; never_captured owns the never-claimed case.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

import { PASS, asof, captureJob, fact, field, jobRow, obs, pipelineRow, unknown } from "./recording.shared.mjs";

export const symptom = "recording.missing_span";
export const expected = "a claimed capture's span is continuous: claimed within the bound, retried without a silent gap, complete on the pipeline";
export const settle_ms = 60_000;
/** The durable claim row, attempt-failure rows, sfu transport rows and the recorder account may all be absent on a healthy claimed capture. */
export const healthy_absent = ["recording.claim", "recording.attempts", "recording.capture_transport", "recording.capture_result"];

const LAG = { colocated: 30_000, fleet: 180_000, default: 30_000 };

export const applies = captureJob;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const job = jobRow(readings);
  const pipeline = pipelineRow(readings);
  if (!job || !pipeline) return unknown("the job or pipeline row is not witnessed");
  const attempts = field(job, "recording_attempt_count", 0);
  if (attempts === 0) return PASS; // never_captured's call

  const claims = obs(readings["recording.claim"]).filter((o) => o.claim === "recording.claimed" || o.claim === "claimed");
  const failures = obs(readings["recording.attempts"]);
  const findings = [];
  const evidence = [job, pipeline];

  if (!claims.length) {
    findings.push({ hop: "capture_claim", text: `attempt_count=${attempts} but no recording.claimed row: the claim span was never journaled` });
  }
  for (const claim of claims) {
    const lag = field(claim, "recording_claim_lag_ms", null);
    if (lag === null) continue;
    const placement = field(claim, "recording_placement", "colocated");
    const bound = LAG[placement] ?? LAG.default;
    if (lag > bound) {
      findings.push({ hop: "capture_claim", text: `claim lag ${lag}ms over the ${bound}ms ${placement} bound` });
      evidence.push(claim);
    }
  }
  for (const f of failures) {
    const claimedAfter = claims.some((c) => c.window.from_ms >= field(f, "recording_failed_ms", 0));
    if (claimedAfter || claims.length) {
      findings.push({ hop: "capture_attempt", text: `attempt ${field(f, "recording_attempt", 0)} failed (${f.claim}) and a later attempt claimed` });
      evidence.push(f);
    }
  }
  if (field(pipeline, "recording_capture_completeness", "complete") === "partial") {
    findings.push({ hop: "capture_complete", text: `capture completeness is partial: ${field(pipeline, "recording_gap_bundles", 0)} gap bundle(s) against ${field(pipeline, "recording_media_bundles", 0)} media` });
  }

  if (!findings.length) return PASS;
  const module = "recorder.capture";
  const at = asof(evidence);
  const hop = findings[0].hop;
  return {
    status: "finding",
    outcome: "degraded",
    window: { from_ms: Math.min(...evidence.map((o) => o.window.from_ms), at), to_ms: at },
    hop,
    module,
    reason: null,
    upstream: "unknown",
    observed: findings.map((f) => f.text).join("; "),
    facts: [
      fact(`job ${job.claim} attempt_count=${attempts}`, [job]),
      ...findings.map((f) => fact(f.text, evidence)),
    ],
    hypothesis: null,
    falsify: { absence: null, attribution: "evidence the capture's span was continuous" },
  };
}
