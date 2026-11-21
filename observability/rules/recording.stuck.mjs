// @ts-check
/**
 * recording.stuck: a capture job pending 15 minutes after it became available, or a capture or export
 * state unmoving past its bound (capture: episode end + 2 minutes; export: committed within 7x the
 * maximum recording duration). Everything is a db read; an unread row is unknown.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

import { PASS, asof, broken, fact, field, jobRow, obs, pipelineRow, unknown } from "./recording.shared.mjs";

export const symptom = "recording.stuck";
export const expected = "capture jobs are claimed within 15 minutes, capture states move within the Episode-end bound, and exports commit within the render bound";
export const settle_ms = 60_000;

const PENDING_BOUND_MS = 15 * 60_000;
const CAPTURE_BOUND_AFTER_END_MS = 2 * 60_000;
/** recordingpipeline.MaximumRenderDuration = 7 x MaximumRecordingDuration (4h) = 28h. */
const RENDER_BOUND_MS = 28 * 60 * 60_000;
const CAPTURE_STATES = new Set(["capture_leased", "capturing_segmented", "capture_complete"]);
const RENDER_STATES = new Set(["render_queued", "rendering", "verifying"]);
const PIPELINE_DONE = new Set(["committed", "retryable_failure", "terminal_failure", "deleted"]);

export const applies = (declaration, seat) => seat === null && declaration.kind === "job" && (declaration.job_kind === "capture" || declaration.job_kind === "render");

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const job = jobRow(readings);
  const pipeline = pipelineRow(readings);
  const episode = obs(readings["recording.episode"])[0];
  if (!job || !pipeline || !episode) return unknown("the job, pipeline or Episode row is not witnessed");
  const asOf = asof([job, pipeline]);
  const jobKind = field(job, "recording_job_kind", "capture");

  if (job.claim === "pending") {
    const wait = asOf - field(job, "recording_available_ms", field(job, "recording_created_ms", asOf));
    if (wait > PENDING_BOUND_MS) {
      return broken({
        hop: jobKind === "render" ? "render_queue" : "capture_claim",
        module: jobKind === "render" ? "recorder.render" : "api.recording_pipeline",
        observed: `job pending ${Math.round(wait / 60000)}min past availability`,
        facts: [fact(`job pending since ${field(job, "recording_available_ms", 0)}`, [job]), fact(`pipeline ${pipeline.claim}`, [pipeline])],
        at: asOf,
        evidence: [job, pipeline],
      });
    }
    return PASS;
  }
  if (job.claim === "succeeded" || job.claim === "terminal_failure" || job.claim === "cancelled") {
    if (jobKind === "capture" && job.claim === "succeeded" && !PIPELINE_DONE.has(pipeline.claim)) {
      // fall through to the pipeline-state check: a finished capture that never commits is stuck downstream
    } else {
      return PASS;
    }
  }

  const state = pipeline.claim;
  const endedAt = field(episode, "recording_episode_ended_ms", null);
  const lastMove = field(pipeline, "recording_updated_ms", asOf);
  if (CAPTURE_STATES.has(state)) {
    if (endedAt !== null && lastMove > endedAt + CAPTURE_BOUND_AFTER_END_MS) return PASS;
    if (endedAt !== null && asOf > endedAt + CAPTURE_BOUND_AFTER_END_MS) {
      return broken({
        hop: "capture_attempt",
        module: "recorder.capture",
        observed: `pipeline ${state} unmoving ${Math.round((asOf - lastMove) / 60000)}min, past the Episode-end bound`,
        facts: [fact(`pipeline ${state} since ${lastMove}`, [pipeline]), fact(`job ${job.claim} attempt=${field(job, "recording_attempt_count", 0)}`, [job]), fact(`Episode ended at ${endedAt}`, [episode])],
        at: asOf,
        evidence: [pipeline, job, episode],
      });
    }
    return PASS;
  }
  if (RENDER_STATES.has(state)) {
    if (asOf - lastMove > RENDER_BOUND_MS) {
      return broken({
        hop: "render",
        module: "recorder.render",
        observed: `pipeline ${state} unmoving ${Math.round((asOf - lastMove) / 3600000)}h past the render bound`,
        facts: [fact(`pipeline ${state} since ${lastMove}`, [pipeline]), fact(`job ${job.claim} attempt=${field(job, "recording_attempt_count", 0)}`, [job])],
        at: asOf,
        evidence: [pipeline, job],
      });
    }
    return PASS;
  }
  return PASS;
}
