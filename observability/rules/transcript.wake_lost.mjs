// @ts-check
/**
 * transcript.wake_lost: the API's wake call to the dispatcher failed, and the first claim came more than 90 s after the job was
 * created — the wake mattered.
 *
 * api decides the wake (`transcript.wake` decision `failed` for this job); db decides the clock (`artifact_jobs.created_at`); the
 * first `transcript.claim` `leased` for any job of the job's transcription, or its absence, decides the delay. A failed wake
 * followed by a claim inside 90 s is no finding. Hop `wake`, module `api.lambdawaker`.
 */
import { field, obs, unknown } from "./transcript.shared.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "transcript.wake_lost";

export const expected = "a failed wake is made good by a claim inside 90 seconds of the job's creation";

const WAKE_LOST_MS = 90_000;

export const settle_ms = 60_000;

/** A job whose wake succeeded needs no claim evidence to pass. */
export const healthy_absent = ["transcript.claim_decision", "transcript.finalize_claim_decision"];

/** @param {Declaration} declaration */
export const applies = (declaration, seat) => seat === null && declaration.kind === "job" && declaration.job_kind === "transcription_chunk";

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const job = readings["transcript.job_state"];
  if (job.kind !== "present") return unknown("the job row is not witnessed");
  const [jobRow] = job.observations;
  const wake = readings["transcript.wake_decision"];
  if (wake.kind !== "present") return unknown("the wake decision is not witnessed");
  const wakes = wake.observations.filter((o) => field(o, "job_id", "") === "" || o.subject.job === jobRow.subject.job || field(o, "job_id", "") === jobRow.subject.job);
  const latest = wakes.sort((a, b) => a.window.to_ms - b.window.to_ms).at(-1);
  if (latest === undefined || latest.claim !== "failed") return { status: "pass" };
  const created = /** @type {number} */ (field(jobRow, "transcript_created_ms", Number.NaN));
  if (!Number.isFinite(created)) return unknown("the job's created_at is not witnessed");
  const first = [...obs(readings["transcript.claim_decision"]), ...obs(readings["transcript.finalize_claim_decision"])]
    .filter((o) => o.claim === "leased")
    .sort((a, b) => a.window.to_ms - b.window.to_ms)
    .at(0);
  const asof = jobRow.window.to_ms;
  const gap = first === undefined ? asof - created : first.window.to_ms - created;
  if (gap <= WAKE_LOST_MS) return { status: "pass" };
  const seconds = Math.round(gap / 1000);
  const claimFacts =
    first === undefined
      ? [{ text: `no claim in ${seconds} s after created_at`, evidence: [jobRow.id], window: { from_ms: created, to_ms: asof }, absent: "transcript.claim_decision" }]
      : [{ text: `first claim ${seconds} s after created_at`, evidence: [first.id, jobRow.id], window: { from_ms: created, to_ms: first.window.to_ms }, absent: null }];
  return {
    status: "finding",
    outcome: "degraded",
    window: { from_ms: latest.window.to_ms, to_ms: first?.window.to_ms ?? asof },
    hop: "wake",
    module: "api.lambdawaker",
    reason: null,
    upstream: "witnessed",
    observed: `wake failed and the first claim came ${seconds} s after the job was created`,
    facts: [{ text: `transcript.wake failed (${field(latest, "reason_code", "unclassified")})`, evidence: [latest.id], window: latest.window, absent: null }, ...claimFacts],
    hypothesis: null,
    falsify: { absence: null, attribution: "a claim inside 90 s of the job's creation, or a wake that succeeded" },
  };
}
