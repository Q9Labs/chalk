import { AssignmentError } from "./errors.js";
import type { SpeakerTurnManifest, TranscriptionAssignment } from "./types.js";
import { exactRow, text, optionalText, nonnegative, integer, positiveInteger, checksum } from "./wire-fields.js";

export function validateSpeakerTurnManifest(value: unknown, assignment: TranscriptionAssignment): SpeakerTurnManifest {
  const manifest = exactRow(value, "manifest", ["schema_version", "tenant_id", "recording_id", "episode_id", "capture_epoch", "duration_ms", "timebase", "presentation_sha256", "producer", "chunk_policy", "chunks"]);
  if (manifest.schema_version !== "recording-transcription-source.v1") throw new AssignmentError("manifest schema is invalid");
  const tenantId = text(manifest.tenant_id, "manifest tenant ID");
  const recordingId = text(manifest.recording_id, "manifest recording ID");
  const episodeId = text(manifest.episode_id, "manifest episode ID");
  const captureEpoch = positiveInteger(manifest.capture_epoch, "manifest capture epoch");
  const durationMs = positiveInteger(manifest.duration_ms, "manifest duration");
  if (manifest.timebase !== "recording_relative_ms") throw new AssignmentError("manifest timebase is invalid");
  const presentationSha256 = checksum(manifest.presentation_sha256, "manifest presentation checksum");

  const producer = exactRow(manifest.producer, "manifest producer", ["render_job_id", "attempt_count", "fencing_generation", "envelope_sha256"]);
  text(producer.render_job_id, "manifest render job ID");
  positiveInteger(producer.attempt_count, "manifest render attempt");
  positiveInteger(producer.fencing_generation, "manifest fencing generation");
  checksum(producer.envelope_sha256, "manifest envelope checksum");

  const policy = exactRow(manifest.chunk_policy, "manifest chunk policy", ["version", "max_duration_ms", "context_ms", "codec", "sample_rate_hz", "channels"]);
  text(policy.version, "manifest chunk policy version", 128);
  const maxDurationMs = positiveInteger(policy.max_duration_ms, "manifest maximum chunk duration");
  if (maxDurationMs > 15 * 60_000 || nonnegative(policy.context_ms, "manifest chunk context") > maxDurationMs || policy.codec !== "flac" || policy.sample_rate_hz !== 16_000 || policy.channels !== 1) {
    throw new AssignmentError("manifest chunk policy is invalid");
  }

  const chunksRaw = manifest.chunks;
  if (!Array.isArray(chunksRaw) || chunksRaw.length === 0 || chunksRaw.length > 10_000) throw new AssignmentError("manifest chunks are invalid");
  const chunkIDs = new Set<string>();
  const allocationIDs = new Set<string>();
  const chunks = chunksRaw.map((item, index) => {
    const chunk = exactRow(item, `manifest chunk ${index}`, [
      "chunk_id",
      "chunk_index",
      "generation",
      "participant_ref",
      "participant_generation",
      "display_name_snapshot",
      "identity_kind",
      "track_id",
      "track_epoch",
      "track_class",
      "start_ms",
      "end_ms",
      "source_start_ms",
      "source_end_ms",
      "overlap",
      "storage",
    ]);
    const chunkId = text(chunk.chunk_id, "manifest chunk ID");
    if (chunkIDs.has(chunkId)) throw new AssignmentError("manifest chunk IDs are duplicated");
    chunkIDs.add(chunkId);
    const chunkIndex = integer(chunk.chunk_index, "manifest chunk index");
    if (chunkIndex !== index) throw new AssignmentError("manifest chunk order is invalid");
    const generation = positiveInteger(chunk.generation, "manifest chunk generation");
    const participantRef = text(chunk.participant_ref, "manifest participant reference", 128);
    const participantGeneration = positiveInteger(chunk.participant_generation, "manifest participant generation");
    const displayNameSnapshot = text(chunk.display_name_snapshot, "manifest display name", 256);
    if (chunk.identity_kind !== "participant" || chunk.track_class !== "microphone") throw new AssignmentError("manifest speaker authority is invalid");
    const trackId = text(chunk.track_id, "manifest track ID", 256);
    const trackEpoch = text(chunk.track_epoch, "manifest track epoch", 128);
    const startMs = integer(chunk.start_ms, "manifest chunk start");
    const endMs = integer(chunk.end_ms, "manifest chunk end");
    const sourceStartMs = integer(chunk.source_start_ms, "manifest source start");
    const sourceEndMs = integer(chunk.source_end_ms, "manifest source end");
    if (endMs <= startMs || endMs > durationMs || sourceEndMs <= sourceStartMs || sourceEndMs - sourceStartMs !== endMs - startMs || endMs - startMs > maxDurationMs) throw new AssignmentError("manifest chunk timing is invalid");
    if (typeof chunk.overlap !== "boolean") throw new AssignmentError("manifest overlap is invalid");
    const storage = exactRow(chunk.storage, "manifest chunk storage", ["allocation_id", "object_key", "object_version", "etag", "content_type", "byte_size", "sha256"]);
    const allocationId = text(storage.allocation_id, "manifest allocation ID");
    if (allocationIDs.has(allocationId)) throw new AssignmentError("manifest allocation IDs are duplicated");
    allocationIDs.add(allocationId);
    const objectKey = text(storage.object_key, "manifest object key", 1_024);
    const objectVersion = optionalText(storage.object_version, "manifest object version", 256);
    const objectEtag = text(storage.etag, "manifest object ETag", 256);
    if (storage.content_type !== "audio/flac") throw new AssignmentError("manifest source content type is invalid");
    const byteSize = positiveInteger(storage.byte_size, "manifest source size");
    const sha256 = checksum(storage.sha256, "manifest source checksum");
    return { chunkId, chunkIndex, generation, participantRef, participantGeneration, displayNameSnapshot, trackId, trackEpoch, startMs, endMs, sourceStartMs, sourceEndMs, overlap: chunk.overlap, allocationId, objectKey, objectVersion, objectEtag, byteSize, sha256 };
  });

  if (tenantId !== assignment.tenantId || recordingId !== assignment.recordingId || episodeId !== assignment.episodeId || presentationSha256 !== assignment.presentationSha256.toLowerCase()) {
    throw new AssignmentError("manifest source authority does not match the assignment");
  }
  const selected = chunks.find((chunk) => chunk.chunkId === assignment.chunk.chunkId);
  if (
    !selected ||
    selected.chunkIndex !== assignment.chunk.chunkIndex ||
    selected.generation !== assignment.chunk.generation ||
    selected.startMs !== assignment.chunk.episodeStartMs ||
    selected.endMs !== assignment.chunk.episodeEndMs ||
    selected.sourceStartMs !== assignment.chunk.sourceStartMs ||
    selected.sourceEndMs !== assignment.chunk.sourceEndMs ||
    selected.participantRef !== assignment.chunk.sourceIdentity.participantRef ||
    selected.participantGeneration !== assignment.chunk.sourceIdentity.participantGeneration ||
    selected.trackId !== assignment.chunk.sourceIdentity.trackId ||
    selected.trackEpoch !== assignment.chunk.sourceIdentity.trackEpoch ||
    selected.displayNameSnapshot !== assignment.chunk.displayNameSnapshot ||
    selected.overlap !== assignment.chunk.overlap ||
    selected.allocationId !== assignment.chunk.allocationId ||
    selected.objectKey !== assignment.chunk.inputObjectKey ||
    selected.objectVersion !== assignment.chunk.objectVersion ||
    selected.objectEtag !== assignment.chunk.objectEtag ||
    selected.byteSize !== assignment.chunk.inputSizeBytes ||
    selected.sha256 !== assignment.chunk.inputSha256.toLowerCase() ||
    assignment.chunk.inputContentType !== "audio/flac" ||
    assignment.chunk.sourceTrackClass !== "microphone"
  ) {
    throw new AssignmentError("manifest chunk authority does not match the assignment");
  }
  return {
    schemaVersion: "recording-transcription-source.v1",
    tenantId,
    recordingId,
    episodeId,
    captureEpoch,
    durationMs,
    timebase: "recording_relative_ms",
    presentationSha256,
    turns: chunks.map((chunk) => ({
      startMs: chunk.startMs,
      endMs: chunk.endMs,
      identity: { kind: "participant", participantRef: chunk.participantRef, participantGeneration: chunk.participantGeneration, trackId: chunk.trackId, trackEpoch: chunk.trackEpoch },
      trackClass: "microphone",
      displayNameSnapshot: chunk.displayNameSnapshot,
      overlap: chunk.overlap,
    })),
  };
}
