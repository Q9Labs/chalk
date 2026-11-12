import { parseTranscriptLanguage } from "@chalk/transcript-language";
import { AssignmentError } from "./errors.js";
import type { ChunkAssignment, CleanupAssignment, FinalizeAssignment, FinalizeChunkAssignment, ManifestAssignment, ManifestIdentity, TranscriptionAssignment } from "./assignment-types.js";
import { MAX_FINALIZER_CHUNKS } from "./finalizer-limits.js";
import { row, text, optionalText, integer, positiveInteger, checksum, expiringUrl, isoTimestamp, isoDate, literal } from "./wire-fields.js";

// Presigned URLs are minted for at most this long.
const MAX_ASSIGNMENT_URL_TTL_MS = 15 * 60_000;
const MAX_LEASE_TOKEN_CHARS = 2_048;

function shortLivedUrl(value: unknown, label: string): string {
  return expiringUrl(value, label, MAX_ASSIGNMENT_URL_TTL_MS);
}

/** A time range of whole milliseconds that ends after it starts. */
function episodeRange(startValue: unknown, endValue: unknown, label: string): { startMs: number; endMs: number } {
  const startMs = integer(startValue, `${label} start`);
  const endMs = integer(endValue, `${label} end`);
  if (!Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs) throw new AssignmentError(`${label} timing is invalid`);
  return { startMs, endMs };
}

export function validateAssignment(value: unknown): TranscriptionAssignment {
  const assignment = row(value, "assignment");
  const chunk = parseChunk(assignment.chunk);
  return {
    transcriptLanguage: parseTranscriptLanguage(assignment.transcript_language === undefined ? "auto" : assignment.transcript_language),
    jobId: text(assignment.job_id, "job ID"),
    tenantId: text(assignment.tenant_id, "tenant ID"),
    episodeId: text(assignment.episode_id, "episode ID"),
    recordingId: text(assignment.recording_id, "recording ID"),
    presentationSha256: checksum(assignment.presentation_sha256, "presentation checksum"),
    sourceExpiresAt: isoTimestamp(assignment.source_expires_at, "source expiry"),
    attempt: integer(assignment.attempt, "attempt"),
    leaseToken: text(assignment.lease_token, "lease token", MAX_LEASE_TOKEN_CHARS),
    leaseExpiresAt: isoDate(assignment.lease_expires_at, "lease expiry"),
    chunk,
    manifest: parseManifestAuthority(assignment.manifest),
    outputPutUrl: shortLivedUrl(assignment.output_put_url, "result upload URL"),
    outputPutUrlExpiresAt: isoDate(assignment.output_put_url_expires_at, "result upload expiry"),
    outputContentType: literal(assignment.output_content_type, "application/json", "result content type"),
  };
}

function parseChunk(value: unknown): ChunkAssignment {
  const chunk = row(value, "chunk");
  const episode = episodeRange(chunk.episode_start_ms, chunk.episode_end_ms, "chunk episode");
  const source = episodeRange(chunk.source_start_ms, chunk.source_end_ms, "chunk source");
  if (source.endMs - source.startMs !== episode.endMs - episode.startMs) throw new AssignmentError("chunk source timing is invalid");
  if (typeof chunk.overlap !== "boolean") throw new AssignmentError("chunk overlap is invalid");
  return {
    chunkId: text(chunk.chunk_id, "chunk ID"),
    inputObjectKey: text(chunk.input_object_key, "chunk object key", 1_024),
    inputUrl: shortLivedUrl(chunk.input_url, "chunk input URL"),
    inputUrlExpiresAt: isoDate(chunk.input_url_expires_at, "chunk input expiry"),
    inputContentType: literal(chunk.input_content_type, "audio/flac", "chunk content type"),
    inputSizeBytes: positiveInteger(chunk.input_size_bytes, "chunk size"),
    inputSha256: checksum(chunk.input_sha256, "chunk checksum"),
    episodeStartMs: episode.startMs,
    episodeEndMs: episode.endMs,
    sourceStartMs: source.startMs,
    sourceEndMs: source.endMs,
    chunkIndex: integer(chunk.chunk_index, "chunk index"),
    generation: positiveInteger(chunk.generation, "chunk generation"),
    allocationId: text(chunk.allocation_id, "chunk allocation ID"),
    objectVersion: optionalText(chunk.object_version, "chunk object version", 256),
    objectEtag: text(chunk.object_etag, "chunk object ETag", 256),
    sourceIdentity: parseSourceIdentity(chunk.source_identity),
    sourceTrackClass: literal(chunk.source_track_class, "microphone", "chunk source track class"),
    displayNameSnapshot: text(chunk.display_name_snapshot, "chunk display name", 256),
    overlap: chunk.overlap,
  };
}

function parseSourceIdentity(value: unknown): ManifestIdentity {
  const identity = row(value, "chunk source identity");
  return {
    kind: literal(identity.kind, "participant", "chunk source identity"),
    participantRef: text(identity.participant_ref, "chunk participant reference", 128),
    participantGeneration: positiveInteger(identity.participant_generation, "chunk participant generation"),
    trackId: text(identity.track_id, "chunk track ID", 256),
    trackEpoch: text(identity.track_epoch, "chunk track epoch", 128),
  };
}

function parseManifestAuthority(value: unknown): ManifestAssignment {
  const manifest = row(value, "manifest authority");
  return {
    inputUrl: shortLivedUrl(manifest.input_url, "manifest input URL"),
    expiresAt: isoDate(manifest.expires_at, "manifest expiry"),
    contentType: literal(manifest.content_type, "application/json", "manifest content type"),
    sizeBytes: positiveInteger(manifest.size_bytes, "manifest size"),
    sha256: checksum(manifest.sha256, "manifest checksum"),
  };
}

export function validateCleanupAssignment(value: unknown): CleanupAssignment {
  const assignment = row(value, "cleanup assignment");
  return {
    jobId: text(assignment.job_id, "cleanup job ID"),
    attempt: integer(assignment.attempt, "cleanup attempt"),
    leaseToken: text(assignment.lease_token, "cleanup lease token", MAX_LEASE_TOKEN_CHARS),
    leaseExpiresAt: isoDate(assignment.lease_expires_at, "cleanup lease expiry"),
    deleteUrl: shortLivedUrl(assignment.delete_url, "cleanup delete URL"),
    deleteUrlExpiresAt: isoDate(assignment.delete_url_expires_at, "cleanup delete URL expiry"),
  };
}

export function validateFinalizeAssignment(value: unknown): FinalizeAssignment {
  const assignment = row(value, "finalize assignment");
  const attempt = integer(assignment.attempt, "finalize attempt");
  if (!Number.isSafeInteger(attempt)) throw new AssignmentError("finalize attempt is invalid");
  return {
    jobId: text(assignment.job_id, "finalize job ID"),
    transcriptId: text(assignment.transcript_id, "transcript ID"),
    episodeId: text(assignment.episode_id, "episode ID"),
    attempt,
    leaseToken: text(assignment.lease_token, "finalize lease token", MAX_LEASE_TOKEN_CHARS),
    leaseExpiresAt: isoDate(assignment.lease_expires_at, "finalize lease expiry"),
    chunks: parseFinalizeChunks(assignment.chunks),
    outputPutUrl: shortLivedUrl(assignment.output_put_url, "final result upload URL"),
    outputPutUrlExpiresAt: isoDate(assignment.output_put_url_expires_at, "final result upload expiry"),
    outputContentType: literal(assignment.output_content_type, "application/json", "final result content type"),
  };
}

function parseFinalizeChunks(value: unknown): FinalizeChunkAssignment[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_FINALIZER_CHUNKS) throw new AssignmentError("finalize chunks are invalid");
  const chunks = value.map((item, index): FinalizeChunkAssignment => {
    const source = row(item, `finalize chunk ${index}`);
    const episode = episodeRange(source.episode_start_ms, source.episode_end_ms, "finalize chunk episode");
    return {
      chunkId: text(source.chunk_id, "finalize chunk ID"),
      inputUrl: shortLivedUrl(source.input_url, "finalize result URL"),
      inputUrlExpiresAt: isoDate(source.input_url_expires_at, "finalize result URL expiry"),
      inputContentType: literal(source.input_content_type, "application/json", "finalize result content type"),
      inputSizeBytes: positiveInteger(source.input_size_bytes, "finalize result size"),
      inputSha256: checksum(source.input_sha256, "finalize result checksum"),
      episodeStartMs: episode.startMs,
      episodeEndMs: episode.endMs,
    };
  });
  if (new Set(chunks.map((chunk) => chunk.chunkId)).size !== chunks.length) throw new AssignmentError("finalize chunk IDs are duplicated");
  return chunks;
}
