// @ts-check
/**
 * transcript.stuck: a transcription stopped moving.
 *
 * s1: an open job in pending or retryable with available_at <= asof-5min (hop claim).
 * s2: a job leased with lease_expires_at <= asof-5min (hop claim; may fire beside attempt_lost).
 * s3: status transcribing, verifying or retryable_failure, no open job, transcriptions.updated_at <= asof-30min — judged on the
 *     transcription's latest job (hop accept, api.transcripts).
 * s4: mode automatic, Recording completed >= 30 min ago, no transcription row and no transcription preparation row — judged on the
 *     Recording's render job (hop admission, api.transcripts).
 *
 * For s1 and s2 the module is dispatcher.schedule when no claim decision ran in the last 5 minutes, api.transcription_worker when
 * claims ran but every one returned none, and unknown when api was not read.
 */
import { TRANSCRIPTION_JOB_KINDS, field, obs, unknown } from "./transcript.shared.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "transcript.stuck";

export const expected = "a due job is claimed within five minutes, a lease never outlives its expiry by five minutes, and a transcription never sits mid-pipeline with no open job for thirty";

const FIVE_MIN = 300_000;
const THIRTY_MIN = 1_800_000;

export const settle_ms = 60_000;

/** A job nobody claimed recently needs no claim decisions to pass. */
export const healthy_absent = ["transcript.claim_decision", "transcript.finalize_claim_decision"];

/** @param {Declaration} declaration */
export const applies = (declaration, seat) =>
  seat === null && declaration.kind === "job" && (TRANSCRIPTION_JOB_KINDS.has(declaration.job_kind) || declaration.job_kind === "render");

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings, declaration }) {
  if (declaration.job_kind === "render") return decideRender(readings);
  const job = readings["transcript.job_state"];
  const row = readings["transcript.row"];
  if (job.kind !== "present") return unknown("the job row is not witnessed");
  if (row.kind !== "present") return unknown("the transcription row is not witnessed");
  const [jobRow] = job.observations;
  const [transcript] = row.observations;
  if (transcript.claim === "deleted" || field(transcript, "transcript_deleted", false) === true || field(transcript, "transcript_exists", true) === false) return { status: "pass" };
  const at = jobRow.window.to_ms;
  const state = jobRow.claim;
  const available = /** @type {number} */ (field(jobRow, "transcript_available_ms", Number.POSITIVE_INFINITY));
  const lease = /** @type {number} */ (field(jobRow, "transcript_lease_expiry_ms", Number.POSITIVE_INFINITY));
  const open = ["pending", "leased", "retryable"].includes(state) ? [jobRow] : [];

  const claimModule = () => {
    const recent = [...obs(readings["transcript.claim_decision"]), ...obs(readings["transcript.finalize_claim_decision"])].filter((o) => o.window.to_ms >= at - FIVE_MIN);
    const apiUnknown = readings["transcript.claim_decision"]?.kind === "unknown" && readings["transcript.finalize_claim_decision"]?.kind === "unknown";
    if (recent.length === 0 && apiUnknown) return "unknown";
    if (recent.length === 0) return "dispatcher.schedule";
    if (recent.every((o) => o.claim === "none")) return "api.transcription_worker";
    return "dispatcher.schedule";
  };

  if (["pending", "retryable"].includes(state) && available <= at - FIVE_MIN) {
    const module = claimModule();
    return {
      status: "finding",
      outcome: "broken",
      window: { from_ms: available, to_ms: at },
      hop: "claim",
      module,
      reason: null,
      upstream: "unknown",
      observed: `job ${state} since ${Math.round((at - available) / 60000)} min without a claim`,
      facts: [{ text: `job ${state}, available ${Math.round((at - available) / 60000)} min`, evidence: [jobRow.id], window: jobRow.window, absent: null }],
      hypothesis: null,
      falsify: { absence: null, attribution: "a claim decision for the job inside five minutes of its due time" },
    };
  }
  if (state === "leased" && lease <= at - FIVE_MIN) {
    const module = claimModule();
    return {
      status: "finding",
      outcome: "broken",
      window: { from_ms: lease, to_ms: at },
      hop: "claim",
      module,
      reason: null,
      upstream: "unknown",
      observed: `job leased, lease expired ${Math.round((at - lease) / 60000)} min ago with no recovery`,
      facts: [{ text: `lease expired ${Math.round((at - lease) / 60000)} min ago`, evidence: [jobRow.id], window: jobRow.window, absent: null }],
      hypothesis: null,
      falsify: { absence: null, attribution: "a recover, retry or complete for the expired lease" },
    };
  }
  const status = transcript.claim;
  const openJobs = /** @type {number} */ (field(transcript, "transcript_open_jobs", open.length));
  const updated = /** @type {number} */ (field(transcript, "transcript_updated_ms", Number.POSITIVE_INFINITY));
  if (["transcribing", "verifying", "retryable_failure"].includes(status) && openJobs === 0 && field(jobRow, "transcript_latest_job", true) === true && updated <= at - THIRTY_MIN) {
    return {
      status: "finding",
      outcome: "broken",
      window: { from_ms: updated, to_ms: at },
      hop: "accept",
      module: "api.transcripts",
      reason: null,
      upstream: "unknown",
      observed: `transcription ${status} with no open job for ${Math.round((at - updated) / 60000)} min`,
      facts: [{ text: `transcription ${status}, last update ${Math.round((at - updated) / 60000)} min ago, no open job`, evidence: [transcript.id, jobRow.id], window: transcript.window, absent: null }],
      hypothesis: null,
      falsify: { absence: null, attribution: "an open job or a terminal status for the transcription" },
    };
  }
  return { status: "pass" };
}

/** s4: the item is the Recording's export job; no transcription row and no preparation row exist. */
/** @param {DecideInput["readings"]} readings @returns {Decision} */
function decideRender(readings) {
  const render = readings["transcript.render"];
  const row = readings["transcript.row"];
  const recording = readings["transcript.recording"];
  const prep = readings["transcript.prep"];
  if (render.kind !== "present" || recording.kind !== "present") return unknown("the render job or Recording row is not witnessed");
  if (row.kind === "unknown" || prep.kind === "unknown") return unknown("the transcription and preparation rows are not witnessed");
  const [renderRow] = render.observations;
  const [recordingRow] = recording.observations;
  const at = renderRow.window.to_ms;
  const mode = /** @type {string} */ (field(recordingRow, "transcript_mode", "disabled"));
  const completed = /** @type {number} */ (field(recordingRow, "transcript_completed_ms", Number.POSITIVE_INFINITY));
  const noTranscript = row.kind === "absent" || row.observations.every((o) => field(o, "transcript_exists", true) === false || o.claim === "none");
  const noPrep = prep.kind === "absent" || prep.observations.every((o) => field(o, "transcript_exists", true) === false || o.claim === "none");
  if (mode === "automatic" && recordingRow.claim === "completed" && completed <= at - THIRTY_MIN && noTranscript && noPrep) {
    return {
      status: "finding",
      outcome: "broken",
      window: { from_ms: completed, to_ms: at },
      hop: "admission",
      module: "api.transcripts",
      reason: null,
      upstream: "unknown",
      observed: `automatic Recording completed ${Math.round((at - completed) / 60000)} min ago; no transcription row and no preparation job`,
      facts: [
        { text: "no transcription row", evidence: row.kind === "present" ? row.observations.map((o) => o.id) : [recordingRow.id], window: { from_ms: completed, to_ms: at }, absent: "transcript.row" },
        { text: "no preparation job", evidence: prep.kind === "present" ? prep.observations.map((o) => o.id) : [renderRow.id], window: { from_ms: completed, to_ms: at }, absent: "transcript.prep" },
        { text: `Recording completed ${Math.round((at - completed) / 60000)} min ago`, evidence: [recordingRow.id], window: recordingRow.window, absent: null },
      ],
      hypothesis: null,
      falsify: { absence: null, attribution: "a transcription row or a preparation job for the completed Recording" },
    };
  }
  return { status: "pass" };
}
