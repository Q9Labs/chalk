import { parseTranscriptLanguage } from "@chalk/transcript-language";
import { AssignmentError } from "./errors.js";
import type { ChunkAssignment, CleanupAssignment, FinalizeAssignment, FinalizeChunkAssignment, TranscriptionAssignment } from "./assignment-types.js";
import { MAX_FINALIZER_CHUNKS } from "./finalizer-limits.js";
import { row, text, optionalText, nonnegative, integer, positiveInteger, checksum, expiringUrl, isoTimestamp, isoDate } from "./wire-fields.js";

// Presigned URLs are minted for at most this long.
const MAX_ASSIGNMENT_URL_TTL_MS = 15 * 60_000;

export function validateAssignment(value: unknown): TranscriptionAssignment {
  const assignment = row(value, "assignment");
  const transcriptLanguage = parseTranscriptLanguage(assignment.transcript_language === undefined ? "auto" : assignment.transcript_language);
  const chunkRow = row(assignment.chunk, "chunk");
  const tenantId = text(assignment.tenant_id, "tenant ID");
  const inputUrl = expiringUrl(chunkRow.input_url, "chunk input URL", MAX_ASSIGNMENT_URL_TTL_MS);
  const outputPutUrl = expiringUrl(assignment.output_put_url, "result upload URL", MAX_ASSIGNMENT_URL_TTL_MS);
  const inputUrlExpiresAt = isoDate(chunkRow.input_url_expires_at, "chunk input expiry");
  const outputPutUrlExpiresAt = isoDate(assignment.output_put_url_expires_at, "result upload expiry");
  const inputContentType = text(chunkRow.input_content_type, "chunk content type", 128);
  if (inputContentType !== "audio/flac") throw new AssignmentError("chunk content type is invalid");
  const inputSizeBytes = integer(chunkRow.input_size_bytes, "chunk size");
  if (inputSizeBytes === 0) throw new AssignmentError("chunk size is invalid");
  const inputObjectKey = text(chunkRow.input_object_key, "chunk object key", 1_024);
  const episodeStartMs = nonnegative(chunkRow.episode_start_ms, "chunk episode start");
  const episodeEndMs = nonnegative(chunkRow.episode_end_ms, "chunk episode end");
  if (!Number.isInteger(episodeStartMs) || !Number.isInteger(episodeEndMs)) throw new AssignmentError("chunk episode timing is invalid");
  if (episodeEndMs <= episodeStartMs) throw new AssignmentError("chunk episode timing is invalid");
  const sourceStartMs = integer(chunkRow.source_start_ms, "chunk source start");
  const sourceEndMs = integer(chunkRow.source_end_ms, "chunk source end");
  if (sourceEndMs <= sourceStartMs || sourceEndMs - sourceStartMs !== episodeEndMs - episodeStartMs) throw new AssignmentError("chunk source timing is invalid");
  const chunkIndex = integer(chunkRow.chunk_index, "chunk index");
  const generation = positiveInteger(chunkRow.generation, "chunk generation");
  const allocationId = text(chunkRow.allocation_id, "chunk allocation ID");
  const objectVersion = optionalText(chunkRow.object_version, "chunk object version", 256);
  const objectEtag = text(chunkRow.object_etag, "chunk object ETag", 256);
  const sourceIdentityRow = row(chunkRow.source_identity, "chunk source identity");
  const sourceKind = sourceIdentityRow.kind;
  if (sourceKind !== "participant") throw new AssignmentError("chunk source identity is invalid");
  const sourceParticipantRef = text(sourceIdentityRow.participant_ref, "chunk participant reference", 128);
  const sourceParticipantGeneration = positiveInteger(sourceIdentityRow.participant_generation, "chunk participant generation");
  const sourceTrackId = text(sourceIdentityRow.track_id, "chunk track ID", 256);
  const sourceTrackEpoch = sourceIdentityRow.track_epoch;
  if (!sourceTrackEpoch) throw new AssignmentError("chunk participant identity is incomplete");
  const sourceTrackClass = chunkRow.source_track_class;
  if (sourceTrackClass !== "microphone") throw new AssignmentError("chunk source track class is invalid");
  const displayNameSnapshot = text(chunkRow.display_name_snapshot, "chunk display name", 256);
  if (typeof chunkRow.overlap !== "boolean") throw new AssignmentError("chunk overlap is invalid");
  const inputSha256 = text(chunkRow.input_sha256, "chunk checksum", 128);
  if (!/^[a-f0-9]{64}$/i.test(inputSha256)) throw new AssignmentError("chunk checksum is invalid");
  const chunk: ChunkAssignment = {
    chunkId: text(chunkRow.chunk_id, "chunk ID"),
    inputObjectKey,
    inputUrl,
    inputUrlExpiresAt,
    inputContentType,
    inputSizeBytes,
    inputSha256,
    episodeStartMs,
    episodeEndMs,
    sourceStartMs,
    sourceEndMs,
    chunkIndex,
    generation,
    allocationId,
    objectVersion,
    objectEtag,
    sourceIdentity: {
      kind: "participant",
      participantRef: sourceParticipantRef,
      participantGeneration: sourceParticipantGeneration,
      trackId: sourceTrackId,
      trackEpoch: text(sourceTrackEpoch, "chunk track epoch", 128),
    },
    sourceTrackClass: "microphone",
    displayNameSnapshot,
    overlap: chunkRow.overlap,
  };
  const manifestRow = row(assignment.manifest, "manifest authority");
  const manifestUrl = expiringUrl(manifestRow.input_url, "manifest input URL", MAX_ASSIGNMENT_URL_TTL_MS);
  const manifestExpiresAt = isoDate(manifestRow.expires_at, "manifest expiry");
  const manifestContentType = manifestRow.content_type;
  if (manifestContentType !== "application/json") throw new AssignmentError("manifest content type is invalid");
  const manifestSizeBytes = integer(manifestRow.size_bytes, "manifest size");
  if (manifestSizeBytes === 0) throw new AssignmentError("manifest size is invalid");
  const manifestSha256 = text(manifestRow.sha256, "manifest checksum", 128);
  if (!/^[a-f0-9]{64}$/i.test(manifestSha256)) throw new AssignmentError("manifest checksum is invalid");
  const outputContentType = assignment.output_content_type;
  if (outputContentType !== "application/json") throw new AssignmentError("result content type is invalid");
  return {
    transcriptLanguage,
    jobId: text(assignment.job_id, "job ID"),
    tenantId,
    episodeId: text(assignment.episode_id, "episode ID"),
    recordingId: text(assignment.recording_id, "recording ID"),
    presentationSha256: checksum(assignment.presentation_sha256, "presentation checksum"),
    sourceExpiresAt: isoTimestamp(assignment.source_expires_at, "source expiry"),
    attempt: integer(assignment.attempt, "attempt"),
    leaseToken: text(assignment.lease_token, "lease token", 2_048),
    leaseExpiresAt: isoDate(assignment.lease_expires_at, "lease expiry"),
    chunk,
    manifest: {
      inputUrl: manifestUrl,
      expiresAt: manifestExpiresAt,
      contentType: "application/json",
      sizeBytes: manifestSizeBytes,
      sha256: manifestSha256,
    },
    outputPutUrl,
    outputPutUrlExpiresAt,
    outputContentType,
  };
}

export function validateCleanupAssignment(value: unknown): CleanupAssignment {
  const assignment = row(value, "cleanup assignment");
  const deleteUrl = expiringUrl(assignment.delete_url, "cleanup delete URL", MAX_ASSIGNMENT_URL_TTL_MS);
  const deleteUrlExpiresAt = isoDate(assignment.delete_url_expires_at, "cleanup delete URL expiry");
  return {
    jobId: text(assignment.job_id, "cleanup job ID"),
    attempt: integer(assignment.attempt, "cleanup attempt"),
    leaseToken: text(assignment.lease_token, "cleanup lease token", 2_048),
    leaseExpiresAt: isoDate(assignment.lease_expires_at, "cleanup lease expiry"),
    deleteUrl,
    deleteUrlExpiresAt,
  };
}

export function validateFinalizeAssignment(value: unknown): FinalizeAssignment {
  const assignment = row(value, "finalize assignment");
  const chunksRaw = assignment.chunks;
  if (!Array.isArray(chunksRaw) || chunksRaw.length === 0 || chunksRaw.length > MAX_FINALIZER_CHUNKS) throw new AssignmentError("finalize chunks are invalid");
  const seenChunkIDs = new Set<string>();
  const chunks = chunksRaw.map((value, index) => {
    const source = row(value, `finalize chunk ${index}`);
    const chunkId = text(source.chunk_id, "finalize chunk ID");
    if (seenChunkIDs.has(chunkId)) throw new AssignmentError("finalize chunk IDs are duplicated");
    seenChunkIDs.add(chunkId);
    const inputUrl = expiringUrl(source.input_url, "finalize result URL", MAX_ASSIGNMENT_URL_TTL_MS);
    const inputUrlExpiresAt = isoDate(source.input_url_expires_at, "finalize result URL expiry");
    const inputContentType = text(source.input_content_type, "finalize result content type", 128);
    if (inputContentType !== "application/json") throw new AssignmentError("finalize result content type is invalid");
    const inputSizeBytes = integer(source.input_size_bytes, "finalize result size");
    if (inputSizeBytes === 0 || !Number.isSafeInteger(inputSizeBytes)) throw new AssignmentError("finalize result size is invalid");
    const inputSha256 = text(source.input_sha256, "finalize result checksum", 128);
    if (!/^[a-f0-9]{64}$/i.test(inputSha256)) throw new AssignmentError("finalize result checksum is invalid");
    const episodeStartMs = integer(source.episode_start_ms, "finalize chunk episode start");
    const episodeEndMs = integer(source.episode_end_ms, "finalize chunk episode end");
    if (!Number.isSafeInteger(episodeStartMs) || !Number.isSafeInteger(episodeEndMs) || episodeEndMs <= episodeStartMs) throw new AssignmentError("finalize chunk episode timing is invalid");
    const chunk: FinalizeChunkAssignment = {
      chunkId,
      inputUrl,
      inputUrlExpiresAt,
      inputContentType: "application/json",
      inputSizeBytes,
      inputSha256,
      episodeStartMs,
      episodeEndMs,
    };
    return chunk;
  });
  const outputPutUrl = expiringUrl(assignment.output_put_url, "final result upload URL", MAX_ASSIGNMENT_URL_TTL_MS);
  const outputPutUrlExpiresAt = isoDate(assignment.output_put_url_expires_at, "final result upload expiry");
  const outputContentType = assignment.output_content_type;
  if (outputContentType !== "application/json") throw new AssignmentError("final result content type is invalid");
  const attempt = integer(assignment.attempt, "finalize attempt");
  if (!Number.isSafeInteger(attempt)) throw new AssignmentError("finalize attempt is invalid");
  return {
    jobId: text(assignment.job_id, "finalize job ID"),
    transcriptId: text(assignment.transcript_id, "transcript ID"),
    episodeId: text(assignment.episode_id, "episode ID"),
    attempt,
    leaseToken: text(assignment.lease_token, "finalize lease token", 2_048),
    leaseExpiresAt: isoDate(assignment.lease_expires_at, "finalize lease expiry"),
    chunks,
    outputPutUrl,
    outputPutUrlExpiresAt,
    outputContentType: "application/json",
  };
}
