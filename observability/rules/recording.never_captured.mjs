// @ts-check
/**
 * recording.never_captured: a capture job nobody ever ran — attempt_count 0, no durable claim row, and the job
 * died of reservation expiry or stop-before-completion. Expected when the Episode ended or a stop landed within
 * the grace before a claim could happen; broken otherwise. Module is recorder.fleet when the API journaled a
 * fleet operation failure, else api.recording_pipeline. An unread source is a gap, never healthy.
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Declaration} Declaration */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

import { PASS, asof, broken, captureJob, expectedFinding, fact, field, jobRow, obs, pipelineRow, recordingRow, unknown } from "./recording.shared.mjs";

export const symptom = "recording.never_captured";
export const expected = "every capture job is claimed and run before its reservation or the Episode ends";
export const settle_ms = 60_000;


/** The stop-before-claim grace: a claim inside this of a stop or the Episode's end is not a fault. */
const GRACE_MS = 20_000;
/** A pending capture job whose reservation window lapsed by this much counts as expired. */
const PENDING_EXPIRY_MS = 10 * 60_000;

/** @param {Declaration} declaration @param {any} seat */
export const applies = captureJob;

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings, window }) {
  const job = jobRow(readings);
  const pipeline = pipelineRow(readings);
  const row = recordingRow(readings);
  const episode = obs(readings["recording.episode"])[0];
  const sync = obs(readings["recording.sync"])[0];
  if (!job || !pipeline || !row || !episode || !sync) return unknown("the job, pipeline, Recording, Episode or Sync row is not witnessed");
  if (field(row, "recording_exists", true) === false) return unknown("the Recording row is missing");
  const claims = obs(readings["recording.claim"]).filter((o) => o.claim === "recording.claimed" || (o.claim === "claimed" && o.source === "api"));
  const claimed = claims.length > 0 || field(job, "recording_attempt_count", 0) > 0;
  if (claimed) return PASS;
  if (job.claim === "succeeded") return PASS;

  const createdMs = field(row, "recording_created_ms", field(job, "recording_created_ms", 0));
  const stopAt = Math.min(
    field(pipeline, "recording_stop_requested_ms", Infinity),
    field(episode, "recording_episode_ended_ms", Infinity),
  );
  const errorCode = field(job, "recording_error_code", "");
  if (Number.isFinite(stopAt) && stopAt - createdMs <= GRACE_MS && (errorCode === "capture_stopped_before_completion" || errorCode === "" || errorCode === "capture_reservation_expired")) {
    const at = stopAt;
    return expectedFinding({
      hop: "capture_claim",
      module: "api.recording_pipeline",
      reason: "recording.stopped_before_claim",
      observed: `stop landed ${stopAt - createdMs}ms after the Recording was created, error_code=${errorCode || "none"}`,
      facts: [
        fact(`Recording created; stop or Episode end ${stopAt - createdMs}ms later`, [row, pipeline, episode]),
        fact(`job ${job.claim} attempt_count=0 error_code=${errorCode || "none"}`, [job]),
      ],
      at,
      evidence: [row, pipeline, episode, job],
    });
  }

  const reservation = obs(readings["recording.reservation"])[0];
  const pendingLong = job.claim === "pending" && field(job, "recording_available_ms", createdMs) + PENDING_EXPIRY_MS <= asof([job]);
  const reservationExpired = reservation?.claim === "expired";
  const terminal = job.claim === "terminal_failure" || job.claim === "cancelled" || reservationExpired || pendingLong;
  if (!terminal) {
    if (field(job, "recording_attempt_count", 0) === 0 && (job.claim === "pending" || job.claim === "leased")) return PASS;
    return PASS;
  }
  const fleet = obs(readings["recording.fleet"])[0];
  const module = fleet ? "recorder.fleet" : "api.recording_pipeline";
  const at = field(job, "recording_terminal_ms", field(job, "recording_updated_ms", asof([job])));
  const code = errorCode || (reservationExpired ? "capture_reservation_expired" : "none");
  return broken({
    hop: "capture_claim",
    module,
    observed: `job ${job.claim} attempt_count=0 with no claim row, error_code=${code}`,
    facts: [
      fact(`job ${job.claim} attempt_count=0 error_code=${code}`, [job]),
      { text: "no recording.claimed row", evidence: [], window, absent: "recording.claim" },
      ...(reservation ? [fact(`reservation ${reservation.claim}`, [reservation])] : []),
      ...(fleet ? [fact(`fleet operation ${fleet.claim} failed`, [fleet])] : []),
    ],
    at,
    evidence: [job, ...(reservation ? [reservation] : []), ...(fleet ? [fleet] : [])],
  });
}
