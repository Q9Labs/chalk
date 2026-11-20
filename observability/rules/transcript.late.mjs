// @ts-check
/**
 * transcript.late: the transcript completed more than 60 minutes after the transcription row was created. Judged on the
 * transcription_finalize job, whose acceptance completes the transcription.
 *
 * db decides: completed_at - created_at > 60 min. Hop and module come from the first job of the transcription with
 * attempt_count > 1, mapped by the spec's error code map on that job's latest error_code; with no such job, claim /
 * dispatcher.queue.
 */
import { errorAttribution, field, unknown } from "./transcript.shared.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "transcript.late";

export const expected = "a transcription completes within 60 minutes of its row being created";

const HOUR_MS = 3_600_000;

export const settle_ms = 60_000;

/** @param {Declaration} declaration */
export const applies = (declaration, seat) => seat === null && declaration.kind === "job" && declaration.job_kind === "transcription_finalize";

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const row = readings["transcript.row"];
  const job = readings["transcript.job_state"];
  if (row.kind !== "present") return unknown("the transcription row is not witnessed");
  if (job.kind !== "present") return unknown("the job row is not witnessed");
  const [transcript] = row.observations;
  const [jobRow] = job.observations;
  if (transcript.claim === "deleted" || field(transcript, "transcript_deleted", false) === true || field(transcript, "transcript_exists", true) === false) return { status: "pass" };
  if (transcript.claim !== "complete") return { status: "pass" };
  const created = /** @type {number} */ (field(transcript, "transcript_created_ms", Number.NaN));
  const completed = /** @type {number} */ (field(transcript, "transcript_completed_ms", Number.NaN));
  if (!Number.isFinite(created) || !Number.isFinite(completed) || completed - created <= HOUR_MS) return { status: "pass" };
  const minutes = Math.round((completed - created) / 60000);
  const retried = /** @type {string} */ (field(jobRow, "transcript_first_retry_kind", ""));
  const code = /** @type {string} */ (field(jobRow, "transcript_first_retry_code", ""));
  const { hop, module } = retried !== "" ? errorAttribution(code, retried) : { hop: "claim", module: "dispatcher.queue" };
  return {
    status: "finding",
    outcome: "degraded",
    window: { from_ms: created, to_ms: completed },
    hop,
    module,
    reason: null,
    upstream: "unknown",
    observed: `completed ${minutes} min after created`,
    facts: [{ text: `completed ${minutes} min after created`, evidence: [transcript.id, jobRow.id], window: { from_ms: created, to_ms: completed }, absent: null }],
    hypothesis: null,
    falsify: { absence: null, attribution: "a transcription that completes inside 60 minutes" },
  };
}
