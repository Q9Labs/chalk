// @ts-check
/**
 * recording.artifact_unreadable: a committed export whose stored object cannot be read back —
 * wrong key, 404, wrong size or checksum, no video stream, bad duration or undecodable bytes.
 * The R2 readback proves readability; recordings.status and a 200 download URL never do.
 * A deleted pipeline means retention, so an absent object is expected(recording.retention_expired).
 */

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

import { PASS, broken, expectedFinding, fact, field, jobRow, obs, pipelineRow, recordingRow, renderJob, unknown } from "./recording.shared.mjs";

export const symptom = "recording.artifact_unreadable";
export const expected = "every committed Recording's object is present, whole and decodable, or its pipeline shows retention deleted it";
export const settle_ms = 60_000;

export const applies = renderJob;

const RESULT_TEXT = {
  ok: "readable",
  not_found: "object not found",
  error: "read failed",
  key_mismatch: "the artifact row names a different object than recordings.storage_key",
  size_mismatch: "stored size differs from the committed byte_size",
  checksum_absent: "no checksum is committed for the object",
  checksum_mismatch: "stored checksum differs from the committed one",
  no_video: "ffprobe found no video stream",
  duration_mismatch: "probed duration differs from the committed duration",
  decode_failed: "the object fails a null-muxer decode",
};

/** @param {DecideInput} input @returns {Decision} */
export function decide({ readings }) {
  const job = jobRow(readings);
  const pipeline = pipelineRow(readings);
  const row = recordingRow(readings);
  const artifact = obs(readings["recording.artifact"])[0];
  const object = obs(readings["recording.object"])[0];
  if (!job || !pipeline || !row || !artifact) return unknown("the job, pipeline, Recording or artifact row is not witnessed");
  if (field(artifact, "recording_artifact_set", false) === false) {
    if (pipeline.claim === "deleted" || row.claim === "deleted") return PASS;
    return unknown("the Recording has no artifact row");
  }
  if (readings["recording.object"]?.kind === "unknown") return unknown("the stored object was not read back");
  if (!object) return unknown("the stored object was not read back");
  const result = object.claim;
  const at = field(artifact, "recording_committed_ms", job.window.to_ms);
  const base = [
    fact(`artifact size=${field(artifact, "recording_size_bytes", "?")} sha_set=${field(artifact, "recording_sha_set", "?")}`, [artifact]),
    fact(`readback ${result}${field(object, "recording_probe_duration_ms", null) !== null ? ` duration=${field(object, "recording_probe_duration_ms", 0)}ms` : ""}`, [object]),
  ];
  if (result === "ok") {
    if (field(artifact, "recording_storage_match", true) === false) {
      return broken({ hop: "artifact_readback", module: "storage.r2", observed: RESULT_TEXT.key_mismatch, facts: [...base, fact("artifact object key != recordings.storage_key", [artifact, row])], at, evidence: [artifact, object] });
    }
    return PASS;
  }
  if (pipeline.claim === "deleted" || row.claim === "deleted") {
    return expectedFinding({
      hop: "artifact_readback",
      module: "storage.r2",
      reason: "recording.retention_expired",
      observed: `readback ${result} on a Recording whose pipeline is deleted: retention`,
      facts: [...base, fact(`pipeline ${pipeline.claim}`, [pipeline])],
      at,
      evidence: [artifact, object, pipeline],
    });
  }
  return broken({
    hop: "artifact_readback",
    module: "storage.r2",
    observed: `committed object unreadable: ${RESULT_TEXT[result] ?? result}`,
    facts: [...base, ...(result === "key_mismatch" || field(artifact, "recording_storage_match", true) === false ? [fact("artifact object key != recordings.storage_key", [artifact, row])] : [])],
    at,
    evidence: [artifact, object],
  });
}
