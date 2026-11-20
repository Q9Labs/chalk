// @ts-check
/**
 * transcript.failed: a job reached dead_letter, or the transcription reached terminal_failure.
 *
 * db decides the outcome: a dead_letter job while the transcription is not complete, deleted or terminal_failure is broken, mapped
 * by the spec's error code map; a terminal_failure with no dead_letter job is broken at accept / api.transcripts. The api and lambda
 * rows carry the same cause witness and only fill the facts. Deleted transcriptions pass every rule.
 */
import { TRANSCRIPTION_JOB_KINDS, errorAttribution, field, obs, unknown, covering } from "./transcript.shared.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "transcript.failed";

export const expected = "every transcription job completes, and a terminal failure always has the dead_letter job that caused it";

/** Job records keep arriving after the row ends (retries, accept decisions). */
export const settle_ms = 60_000;

/** A healthy job has no retry, no failed chunk or finalize op: their proven absence is the healthy claim. */
export const healthy_absent = ["transcript.retry_decision", "transcript.finalize_retry_decision", "transcript.chunk_op", "transcript.finalize_op"];

/** @param {Declaration} declaration */
export const applies = (declaration, seat) => seat === null && declaration.kind === "job" && TRANSCRIPTION_JOB_KINDS.has(declaration.job_kind);

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const job = readings["transcript.job_state"];
  const row = readings["transcript.row"];
  if (job.kind !== "present") return unknown("the job row is not witnessed");
  if (row.kind !== "present") return unknown("the transcription row is not witnessed");
  const [jobRow] = job.observations;
  const [transcript] = row.observations;
  const status = transcript.claim;
  if (status === "deleted" || field(transcript, "transcript_deleted", false) === true) return { status: "pass" };
  if (field(transcript, "transcript_exists", true) === false) return unknown("the Recording has no transcription row");
  const jobKind = /** @type {string} */ (field(jobRow, "transcript_job_kind", "transcription_chunk"));
  const retries = [...obs(readings["transcript.retry_decision"]), ...obs(readings["transcript.finalize_retry_decision"])];
  const ops = [...obs(readings["transcript.chunk_op"]), ...obs(readings["transcript.finalize_op"])];
  const deadLetters = Math.max(/** @type {number} */ (field(jobRow, "transcript_dead_letter_jobs", 0)), /** @type {number} */ (field(transcript, "transcript_dead_letter_jobs", 0)));
  const latest = field(jobRow, "transcript_latest_job", true) === true;
  if (jobRow.claim === "dead_letter" && status !== "complete" && status !== "deleted") {
    const code = /** @type {string} */ (field(jobRow, "transcript_error_code", ""));
    const { hop, module } = errorAttribution(code, jobKind);
    const terminal = /** @type {number} */ (field(jobRow, "transcript_terminal_ms", jobRow.window.to_ms));
    return {
      status: "finding",
      outcome: "broken",
      window: covering([...retries, ...ops], terminal),
      hop,
      module,
      reason: null,
      upstream: "unknown",
      observed: `job ${jobRow.claim} error_code=${code || "none"} attempt=${field(jobRow, "transcript_attempt_count", 0)}/${field(jobRow, "transcript_attempt_limit", 0)}`,
      facts: [
        { text: `job ${jobRow.claim} error_code=${code || "none"} attempt=${field(jobRow, "transcript_attempt_count", 0)}/${field(jobRow, "transcript_attempt_limit", 0)}`, evidence: [jobRow.id, ...retries.map((o) => o.id), ...ops.map((o) => o.id)], window: jobRow.window, absent: null },
        { text: `transcription ${status}`, evidence: [transcript.id], window: transcript.window, absent: null },
      ],
      hypothesis: null,
      falsify: { absence: null, attribution: `a ${jobKind === "transcription_finalize" ? "finalize" : "chunk"} job that completed or a transcription that completed` },
    };
  }
  if (status === "terminal_failure" && latest && deadLetters === 0) {
    const terminal = /** @type {number} */ (field(transcript, "transcript_updated_ms", transcript.window.to_ms));
    return {
      status: "finding",
      outcome: "broken",
      window: { from_ms: terminal, to_ms: terminal },
      hop: "accept",
      module: "api.transcripts",
      reason: null,
      upstream: "unknown",
      observed: "terminal_failure with no dead_letter job",
      facts: [
        { text: "terminal_failure with no dead_letter job", evidence: [transcript.id], window: transcript.window, absent: null },
        { text: `job ${jobRow.claim} attempt=${field(jobRow, "transcript_attempt_count", 0)}/${field(jobRow, "transcript_attempt_limit", 0)}`, evidence: [jobRow.id], window: jobRow.window, absent: null },
      ],
      hypothesis: null,
      falsify: { absence: null, attribution: "a dead_letter job whose error names the failing hop" },
    };
  }
  return { status: "pass" };
}
