// @ts-check
/**
 * transcript.attempt_lost: a claimed chunk attempt's lease expired with no accepted result and no accepted retry, so the work was
 * silently dropped and waits for lease recovery.
 *
 * db decides: the job row shows `state = leased` with `lease_expires_at <= asof`, or `error_code = lease_expired` on a recovered
 * row. An attempt of that job is lost when it was claimed (a transcript.claim `leased` decision or a still-`started` attempt row)
 * and no accepted `transcript.job_complete` and no `transcript.job_retry` name it — unless it holds the job's current unexpired
 * lease. The claim decision picks the module: `url_failed`, `invalid_assignment` or `lease_stale` mean the handler leased the job
 * and then failed the response (issue #1510), giving `api.transcription_worker`; anything else gives `dispatcher.runtime`; `api`
 * not read gives `unknown`. Several lost attempts of one job make one finding with a `fact:` line each.
 */
import { CLAIM_HANDLER_FAILURES, field, obs, unknown } from "./transcript.shared.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "transcript.attempt_lost";

export const expected = "every claimed chunk attempt ends in an accepted result or a reported retry before its lease expires";

export const settle_ms = 60_000;

/** A job never claimed, never run and never answered has no claim/complete/retry rows or chunk op: their proven absence is the healthy claim. The db job row alone still decides a lease-expired loss. */
export const healthy_absent = ["transcript.attempts", "transcript.claim_decision", "transcript.complete_decision", "transcript.retry_decision", "transcript.chunk_op"];

/** @param {Declaration} declaration */
export const applies = (declaration, seat) => seat === null && declaration.kind === "job" && declaration.job_kind === "transcription_chunk";

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const job = readings["transcript.job_state"];
  if (job.kind !== "present") return unknown("the job row is not witnessed");
  const [jobRow] = job.observations;
  const at = jobRow.window.to_ms;
  const lease = /** @type {number} */ (field(jobRow, "transcript_lease_expiry_ms", Number.POSITIVE_INFINITY));
  const expiredNow = jobRow.claim === "leased" && lease <= at;
  const recovered = /** @type {string} */ (field(jobRow, "transcript_error_code", "")) === "lease_expired";
  if (!expiredNow && !recovered) return { status: "pass" };
  const current = /** @type {number} */ (field(jobRow, "transcript_attempt_count", 0));

  const claims = obs(readings["transcript.claim_decision"]);
  const completes = obs(readings["transcript.complete_decision"]);
  const retries = obs(readings["transcript.retry_decision"]);
  const attempts = obs(readings["transcript.attempts"]);
  const apiRead = readings["transcript.claim_decision"]?.kind !== "unknown";

  const answered = (/** @type {number} */ n) => completes.some((o) => o.claim === "accepted" && field(o, "attempt", 0) === n) || retries.some((o) => field(o, "attempt", 0) === n);
  const candidates = new Set();
  for (const o of claims.filter((entry) => entry.claim === "leased")) candidates.add(/** @type {number} */ (field(o, "attempt", 0)));
  for (const o of attempts.filter((entry) => entry.claim === "started")) candidates.add(/** @type {number} */ (field(o, "attempt", 0)));
  if (expiredNow || recovered) candidates.add(current);

  /** @type {{ attempt: number, why: string, claim: import("./transcript.shared.mjs").Observation | undefined }[]} */
  const lost = [];
  for (const n of [...candidates].sort((a, b) => a - b)) {
    if (n === 0 || answered(n)) continue;
    if (n === current && jobRow.claim === "leased" && lease > at) continue;
    const claim = claims.filter((o) => field(o, "attempt", 0) === n).at(-1);
    lost.push({ attempt: n, why: n === current && expiredNow ? "lease expired" : recovered ? "lease recovered" : "lease expired", claim });
  }
  if (lost.length === 0) return { status: "pass" };

  const handlerFault = lost.some((entry) => entry.claim !== undefined && CLAIM_HANDLER_FAILURES.has(entry.claim.claim));
  const facts = lost.map((entry) => ({
    text: `attempt ${entry.attempt} ${entry.why}${entry.claim && entry.claim.claim !== "leased" ? ` (claim ${entry.claim.claim})` : ""}, no accepted result or retry`,
    evidence: [jobRow.id, ...(entry.claim ? [entry.claim.id] : []), ...attempts.filter((o) => field(o, "attempt", 0) === entry.attempt).map((o) => o.id)],
    window: jobRow.window,
    absent: "transcript.complete_decision",
  }));
  const module = !apiRead ? "unknown" : handlerFault ? "api.transcription_worker" : "dispatcher.runtime";
  return {
    status: "finding",
    outcome: "degraded",
    window: { from_ms: Math.min(lease <= at ? lease : at, at), to_ms: at },
    hop: "chunk",
    module,
    reason: null,
    upstream: "unknown",
    observed: `attempt${lost.length > 1 ? "s" : ""} ${lost.map((entry) => entry.attempt).join(", ")} claimed and lost: no accepted result or retry, lease ${expiredNow ? "expired" : "recovered"}`,
    facts,
    hypothesis: handlerFault ? { text: "the claim handler leased the job and then failed the response (issue #1510), orphaning the lease for the work lease duration", falsified_by: "a commit that undoes the lease when the assignment fails" } : null,
    falsify: { absence: null, attribution: "an accepted result or retry decision for each lost attempt" },
  };
}
