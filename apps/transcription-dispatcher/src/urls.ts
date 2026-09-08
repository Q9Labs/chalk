import { AssignmentError } from "./errors.js";
import type { ChunkAssignment, CleanupAssignment, FinalizeAssignment, FinalizeChunkAssignment, SpeakerTurnManifest, TranscriptionAssignment } from "./types.js";
import { MAX_FINALIZER_CHUNKS } from "./finalizer-limits.js";

function row(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssignmentError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function exactRow(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  const valueRow = row(value, label);
  const expected = new Set(keys);
  if (Object.keys(valueRow).length !== expected.size || Object.keys(valueRow).some((key) => !expected.has(key))) throw new AssignmentError(`${label} fields are invalid`);
  return valueRow;
}

function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new AssignmentError(`${label} is invalid`);
  return value;
}

function optionalText(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.length > max) throw new AssignmentError(`${label} is invalid`);
  return value;
}

function nonnegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new AssignmentError(`${label} is invalid`);
  return value;
}

function integer(value: unknown, label: string): number {
  const number = nonnegative(value, label);
  if (!Number.isInteger(number)) throw new AssignmentError(`${label} is invalid`);
  return number;
}

function positiveInteger(value: unknown, label: string): number {
  const number = integer(value, label);
  if (number < 1 || !Number.isSafeInteger(number)) throw new AssignmentError(`${label} is invalid`);
  return number;
}

function checksum(value: unknown, label: string): string {
  const digest = text(value, label, 64).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new AssignmentError(`${label} is invalid`);
  return digest;
}

function expiringUrl(value: unknown, label: string, maxTtlMs: number): string {
  const urlText = text(value, label, 4_096);
  let url: URL;
  try {
    url = new URL(urlText);
  } catch {
    throw new AssignmentError(`${label} is invalid`);
  }
  if (url.protocol !== "https:") throw new AssignmentError(`${label} must use HTTPS`);
  const expiryRaw = url.searchParams.get("X-Amz-Expires") ?? url.searchParams.get("expires");
  const dateRaw = url.searchParams.get("X-Amz-Date");
  if (!expiryRaw || !/^\d+$/.test(expiryRaw)) throw new AssignmentError(`${label} has no short-lived expiry`);
  const expirySeconds = Number(expiryRaw);
  if (!Number.isInteger(expirySeconds) || expirySeconds < 1 || expirySeconds * 1_000 > maxTtlMs) {
    throw new AssignmentError(`${label} exceeds short-lived TTL`);
  }
  if (dateRaw) {
    const date = /^\d{8}T\d{6}Z$/.test(dateRaw) ? Date.UTC(Number(dateRaw.slice(0, 4)), Number(dateRaw.slice(4, 6)) - 1, Number(dateRaw.slice(6, 8)), Number(dateRaw.slice(9, 11)), Number(dateRaw.slice(11, 13)), Number(dateRaw.slice(13, 15))) : Number.NaN;
    if (!Number.isFinite(date)) throw new AssignmentError(`${label} signing date is invalid`);
    if (date + expirySeconds * 1_000 < Date.now() - 60_000) throw new AssignmentError(`${label} is expired`);
  }
  return url.toString();
}

function isoTimestamp(value: unknown, label: string): string {
  const date = text(value, label, 64);
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp)) throw new AssignmentError(`${label} is invalid`);
  return date;
}

function isoDate(value: unknown, label: string): string {
  const date = isoTimestamp(value, label);
  if (Date.parse(date) < Date.now() - 60_000) throw new AssignmentError(`${label} is expired`);
  return date;
}

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

export function validateAssignment(value: unknown, configuredMaxTtlMs = 15 * 60_000): TranscriptionAssignment {
  const assignment = row(value, "assignment");
  const chunkRow = row(assignment.chunk, "chunk");
  const tenantId = text(assignment.tenantId, "tenant ID");
  const inputUrl = expiringUrl(chunkRow.inputUrl, "chunk input URL", configuredMaxTtlMs);
  const outputPutUrl = expiringUrl(assignment.outputPutUrl, "result upload URL", configuredMaxTtlMs);
  const inputUrlExpiresAt = isoDate(chunkRow.inputUrlExpiresAt, "chunk input expiry");
  const outputPutUrlExpiresAt = isoDate(assignment.outputPutUrlExpiresAt, "result upload expiry");
  const inputContentType = text(chunkRow.inputContentType, "chunk content type", 128);
  if (inputContentType !== "audio/flac") throw new AssignmentError("chunk content type is invalid");
  const inputSizeBytes = integer(chunkRow.inputSizeBytes, "chunk size");
  if (inputSizeBytes === 0) throw new AssignmentError("chunk size is invalid");
  const inputObjectKey = text(chunkRow.inputObjectKey, "chunk object key", 1_024);
  const episodeStartMs = nonnegative(chunkRow.episodeStartMs, "chunk episode start");
  const episodeEndMs = nonnegative(chunkRow.episodeEndMs, "chunk episode end");
  if (!Number.isInteger(episodeStartMs) || !Number.isInteger(episodeEndMs)) throw new AssignmentError("chunk episode timing is invalid");
  if (episodeEndMs <= episodeStartMs) throw new AssignmentError("chunk episode timing is invalid");
  const sourceStartMs = integer(chunkRow.sourceStartMs ?? chunkRow.source_start_ms, "chunk source start");
  const sourceEndMs = integer(chunkRow.sourceEndMs ?? chunkRow.source_end_ms, "chunk source end");
  if (sourceEndMs <= sourceStartMs || sourceEndMs - sourceStartMs !== episodeEndMs - episodeStartMs) throw new AssignmentError("chunk source timing is invalid");
  const chunkIndex = integer(chunkRow.chunkIndex ?? chunkRow.chunk_index, "chunk index");
  const generation = positiveInteger(chunkRow.generation, "chunk generation");
  const allocationId = text(chunkRow.allocationId ?? chunkRow.allocation_id, "chunk allocation ID");
  const objectVersion = optionalText(chunkRow.objectVersion ?? chunkRow.object_version, "chunk object version", 256);
  const objectEtag = text(chunkRow.objectEtag ?? chunkRow.object_etag, "chunk object ETag", 256);
  const sourceIdentityRow = row(chunkRow.sourceIdentity ?? chunkRow.source_identity, "chunk source identity");
  const sourceKind = sourceIdentityRow.kind;
  if (sourceKind !== "participant") throw new AssignmentError("chunk source identity is invalid");
  const sourceParticipantRef = text(sourceIdentityRow.participantRef ?? sourceIdentityRow.participant_ref, "chunk participant reference", 128);
  const sourceParticipantGeneration = positiveInteger(sourceIdentityRow.participantGeneration ?? sourceIdentityRow.participant_generation, "chunk participant generation");
  const sourceTrackId = text(sourceIdentityRow.trackId ?? sourceIdentityRow.track_id, "chunk track ID", 256);
  const sourceTrackEpoch = sourceIdentityRow.trackEpoch ?? sourceIdentityRow.track_epoch;
  if (!sourceTrackEpoch) throw new AssignmentError("chunk participant identity is incomplete");
  const sourceTrackClass = chunkRow.sourceTrackClass ?? chunkRow.source_track_class;
  if (sourceTrackClass !== "microphone") throw new AssignmentError("chunk source track class is invalid");
  const displayNameSnapshot = text(chunkRow.displayNameSnapshot ?? chunkRow.display_name_snapshot, "chunk display name", 256);
  if (typeof chunkRow.overlap !== "boolean") throw new AssignmentError("chunk overlap is invalid");
  const inputSha256 = text(chunkRow.inputSha256, "chunk checksum", 128);
  if (!/^[a-f0-9]{64}$/i.test(inputSha256)) throw new AssignmentError("chunk checksum is invalid");
  const chunk: ChunkAssignment = {
    chunkId: text(chunkRow.chunkId, "chunk ID"),
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
  const manifestRow = row(assignment.manifest ?? assignment.speakerTurnManifest, "manifest authority");
  const manifestUrl = expiringUrl(manifestRow.inputUrl ?? manifestRow.input_url, "manifest input URL", configuredMaxTtlMs);
  const manifestExpiresAt = isoDate(manifestRow.expiresAt ?? manifestRow.expires_at, "manifest expiry");
  const manifestContentType = manifestRow.contentType ?? manifestRow.content_type;
  if (manifestContentType !== "application/json") throw new AssignmentError("manifest content type is invalid");
  const manifestSizeBytes = integer(manifestRow.sizeBytes ?? manifestRow.size_bytes, "manifest size");
  if (manifestSizeBytes === 0) throw new AssignmentError("manifest size is invalid");
  const manifestSha256 = text(manifestRow.sha256, "manifest checksum", 128);
  if (!/^[a-f0-9]{64}$/i.test(manifestSha256)) throw new AssignmentError("manifest checksum is invalid");
  const outputContentType = assignment.outputContentType;
  if (outputContentType !== "application/json") throw new AssignmentError("result content type is invalid");
  return {
    jobId: text(assignment.jobId, "job ID"),
    tenantId,
    episodeId: text(assignment.episodeId, "episode ID"),
    recordingId: text(assignment.recordingId ?? assignment.recording_id, "recording ID"),
    presentationSha256: checksum(assignment.presentationSha256 ?? assignment.presentation_sha256, "presentation checksum"),
    sourceExpiresAt: isoTimestamp(assignment.sourceExpiresAt ?? assignment.source_expires_at, "source expiry"),
    attempt: integer(assignment.attempt, "attempt"),
    leaseToken: text(assignment.leaseToken, "lease token", 2_048),
    leaseExpiresAt: isoDate(assignment.leaseExpiresAt, "lease expiry"),
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

export function validateCleanupAssignment(value: unknown, configuredMaxTtlMs = 15 * 60_000): CleanupAssignment {
  const assignment = row(value, "cleanup assignment");
  const deleteUrl = expiringUrl(assignment.deleteUrl ?? assignment.delete_url, "cleanup delete URL", configuredMaxTtlMs);
  const deleteUrlExpiresAt = isoDate(assignment.deleteUrlExpiresAt ?? assignment.delete_url_expires_at, "cleanup delete URL expiry");
  return {
    jobId: text(assignment.jobId ?? assignment.job_id, "cleanup job ID"),
    attempt: integer(assignment.attempt, "cleanup attempt"),
    leaseToken: text(assignment.leaseToken ?? assignment.lease_token, "cleanup lease token", 2_048),
    leaseExpiresAt: isoDate(assignment.leaseExpiresAt ?? assignment.lease_expires_at, "cleanup lease expiry"),
    deleteUrl,
    deleteUrlExpiresAt,
  };
}

export function validateFinalizeAssignment(value: unknown, configuredMaxTtlMs = 15 * 60_000, maxChunks = MAX_FINALIZER_CHUNKS): FinalizeAssignment {
  const assignment = row(value, "finalize assignment");
  if (!Number.isSafeInteger(maxChunks) || maxChunks < 1 || maxChunks > MAX_FINALIZER_CHUNKS) throw new AssignmentError("finalize chunk bound is invalid");
  const chunksRaw = assignment.chunks ?? assignment.chunk_results ?? assignment.results;
  if (!Array.isArray(chunksRaw) || chunksRaw.length === 0 || chunksRaw.length > maxChunks) throw new AssignmentError("finalize chunks are invalid");
  const seenChunkIDs = new Set<string>();
  const chunks = chunksRaw.map((value, index) => {
    const source = row(value, `finalize chunk ${index}`);
    const chunkId = text(source.chunkId ?? source.chunk_id, "finalize chunk ID");
    if (seenChunkIDs.has(chunkId)) throw new AssignmentError("finalize chunk IDs are duplicated");
    seenChunkIDs.add(chunkId);
    const inputUrl = expiringUrl(source.inputUrl ?? source.input_url ?? source.resultUrl ?? source.result_url ?? source.resultGetUrl ?? source.result_get_url, "finalize result URL", configuredMaxTtlMs);
    const inputUrlExpiresAt = isoDate(source.inputUrlExpiresAt ?? source.input_url_expires_at, "finalize result URL expiry");
    const inputContentType = text(source.inputContentType ?? source.input_content_type, "finalize result content type", 128);
    if (inputContentType !== "application/json") throw new AssignmentError("finalize result content type is invalid");
    const inputSizeBytes = integer(source.inputSizeBytes ?? source.input_size_bytes ?? source.resultSizeBytes ?? source.result_size_bytes, "finalize result size");
    if (inputSizeBytes === 0 || !Number.isSafeInteger(inputSizeBytes)) throw new AssignmentError("finalize result size is invalid");
    const inputSha256 = text(source.inputSha256 ?? source.input_sha256 ?? source.resultSha256 ?? source.result_sha256, "finalize result checksum", 128);
    if (!/^[a-f0-9]{64}$/i.test(inputSha256)) throw new AssignmentError("finalize result checksum is invalid");
    const episodeStartMs = integer(source.episodeStartMs, "finalize chunk episode start");
    const episodeEndMs = integer(source.episodeEndMs, "finalize chunk episode end");
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
  const outputPutUrl = expiringUrl(assignment.outputPutUrl ?? assignment.output_put_url ?? assignment.finalPutUrl ?? assignment.final_put_url, "final result upload URL", configuredMaxTtlMs);
  const outputPutUrlExpiresAt = isoDate(assignment.outputPutUrlExpiresAt ?? assignment.output_put_url_expires_at ?? assignment.finalPutUrlExpiresAt ?? assignment.final_put_url_expires_at, "final result upload expiry");
  const outputContentType = assignment.outputContentType ?? assignment.output_content_type;
  if (outputContentType !== "application/json") throw new AssignmentError("final result content type is invalid");
  const attempt = integer(assignment.attempt, "finalize attempt");
  if (!Number.isSafeInteger(attempt)) throw new AssignmentError("finalize attempt is invalid");
  return {
    jobId: text(assignment.jobId ?? assignment.job_id, "finalize job ID"),
    transcriptId: text(assignment.transcriptId ?? assignment.transcript_id, "transcript ID"),
    episodeId: text(assignment.episodeId, "episode ID"),
    attempt,
    leaseToken: text(assignment.leaseToken ?? assignment.lease_token, "finalize lease token", 2_048),
    leaseExpiresAt: isoDate(assignment.leaseExpiresAt ?? assignment.lease_expires_at, "finalize lease expiry"),
    chunks,
    outputPutUrl,
    outputPutUrlExpiresAt,
    outputContentType: "application/json",
  };
}
