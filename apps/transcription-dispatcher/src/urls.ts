import { AssignmentError } from "./errors.js";
import type { ChunkAssignment, CleanupAssignment, FinalizeAssignment, FinalizeChunkAssignment, SpeakerTurnManifest, TranscriptionAssignment } from "./types.js";

function row(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssignmentError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new AssignmentError(`${label} is invalid`);
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

function isoDate(value: unknown, label: string): string {
  const date = text(value, label, 64);
  const timestamp = Date.parse(date);
  if (!Number.isFinite(timestamp) || timestamp < Date.now() - 60_000) throw new AssignmentError(`${label} is invalid or expired`);
  return date;
}

export function validateSpeakerTurnManifest(value: unknown): SpeakerTurnManifest {
  const manifest = row(value, "manifest");
  const schemaVersion = text(manifest.schemaVersion, "manifest schema", 128);
  const turnsRaw = manifest.turns;
  if (!Array.isArray(turnsRaw) || turnsRaw.length > 100_000) throw new AssignmentError("manifest turns are invalid");
  const turns = turnsRaw.map((item, index) => {
    const turn = row(item, `manifest turn ${index}`);
    const startMs = nonnegative(turn.startMs, "manifest turn start");
    const endMs = nonnegative(turn.endMs, "manifest turn end");
    if (!Number.isInteger(startMs) || !Number.isInteger(endMs)) throw new AssignmentError("manifest turn timing is invalid");
    if (endMs <= startMs) throw new AssignmentError("manifest turn timing is invalid");
    const identity = row(turn.identity, "manifest identity");
    const kind = identity.kind;
    if (kind !== "participant" && kind !== "shared" && kind !== "unknown") throw new AssignmentError("manifest identity is invalid");
    const participantId = identity.participantId === undefined ? undefined : text(identity.participantId, "manifest participant", 256);
    const trackEpoch = identity.trackEpoch === undefined ? undefined : text(identity.trackEpoch, "manifest track epoch", 256);
    if (kind === "participant" && (!participantId || !trackEpoch)) throw new AssignmentError("participant identity is incomplete");
    if (kind !== "participant" && (participantId !== undefined || trackEpoch !== undefined)) throw new AssignmentError("shared or unknown identity may not carry participant authority");
    const trackClass = turn.trackClass;
    if (trackClass !== "microphone" && trackClass !== "screen-share" && trackClass !== "system-audio" && trackClass !== "unknown") throw new AssignmentError("manifest track class is invalid");
    const displayNameSnapshot = turn.displayNameSnapshot === undefined ? undefined : text(turn.displayNameSnapshot, "display name", 256);
    if (displayNameSnapshot && (kind !== "participant" || trackClass !== "microphone")) throw new AssignmentError("display name is not valid for this track");
    if (typeof turn.overlap !== "boolean") throw new AssignmentError("manifest overlap is invalid");
    return {
      startMs,
      endMs,
      identity: {
        kind: kind as "participant" | "shared" | "unknown",
        ...(participantId === undefined ? {} : { participantId }),
        ...(trackEpoch === undefined ? {} : { trackEpoch }),
      },
      trackClass: trackClass as "microphone" | "screen-share" | "system-audio" | "unknown",
      ...(displayNameSnapshot === undefined ? {} : { displayNameSnapshot }),
      overlap: turn.overlap,
    };
  });
  return { schemaVersion, turns };
}

export function validateAssignment(value: unknown, configuredMaxTtlMs = 15 * 60_000): TranscriptionAssignment {
  const assignment = row(value, "assignment");
  const chunkRow = row(assignment.chunk, "chunk");
  const inputUrl = expiringUrl(chunkRow.inputUrl, "chunk input URL", configuredMaxTtlMs);
  const outputPutUrl = expiringUrl(assignment.outputPutUrl, "result upload URL", configuredMaxTtlMs);
  const inputUrlExpiresAt = isoDate(chunkRow.inputUrlExpiresAt, "chunk input expiry");
  const outputPutUrlExpiresAt = isoDate(assignment.outputPutUrlExpiresAt, "result upload expiry");
  const inputContentType = text(chunkRow.inputContentType, "chunk content type", 128);
  if (!inputContentType.startsWith("audio/")) throw new AssignmentError("chunk content type must be audio");
  const inputSizeBytes = integer(chunkRow.inputSizeBytes, "chunk size");
  if (inputSizeBytes === 0) throw new AssignmentError("chunk size is invalid");
  const meetingStartMs = nonnegative(chunkRow.meetingStartMs, "chunk meeting start");
  const meetingEndMs = nonnegative(chunkRow.meetingEndMs, "chunk meeting end");
  if (!Number.isInteger(meetingStartMs) || !Number.isInteger(meetingEndMs)) throw new AssignmentError("chunk meeting timing is invalid");
  if (meetingEndMs <= meetingStartMs) throw new AssignmentError("chunk meeting timing is invalid");
  const sourceIdentityRow = row(chunkRow.sourceIdentity ?? chunkRow.source_identity, "chunk source identity");
  const sourceKind = sourceIdentityRow.kind;
  if (sourceKind !== "participant" && sourceKind !== "shared" && sourceKind !== "unknown") throw new AssignmentError("chunk source identity is invalid");
  const sourceParticipantId = sourceIdentityRow.participantId ?? sourceIdentityRow.participant_id;
  const sourceTrackEpoch = sourceIdentityRow.trackEpoch ?? sourceIdentityRow.track_epoch;
  if (sourceKind === "participant" && (!sourceParticipantId || !sourceTrackEpoch)) throw new AssignmentError("chunk participant identity is incomplete");
  if (sourceKind !== "participant" && (sourceParticipantId !== undefined || sourceTrackEpoch !== undefined)) throw new AssignmentError("chunk source identity is invalid");
  const sourceTrackClass = chunkRow.sourceTrackClass ?? chunkRow.source_track_class;
  if (sourceTrackClass !== "microphone" && sourceTrackClass !== "screen-share" && sourceTrackClass !== "system-audio" && sourceTrackClass !== "unknown") throw new AssignmentError("chunk source track class is invalid");
  const inputSha256 = text(chunkRow.inputSha256, "chunk checksum", 128);
  if (!/^[a-f0-9]{64}$/i.test(inputSha256)) throw new AssignmentError("chunk checksum is invalid");
  const chunk: ChunkAssignment = {
    chunkId: text(chunkRow.chunkId, "chunk ID"),
    inputUrl,
    inputUrlExpiresAt,
    inputContentType,
    inputSizeBytes,
    inputSha256,
    meetingStartMs,
    meetingEndMs,
    sourceIdentity: {
      kind: sourceKind,
      ...(sourceParticipantId === undefined ? {} : { participantId: text(sourceParticipantId, "chunk participant", 256) }),
      ...(sourceTrackEpoch === undefined ? {} : { trackEpoch: text(sourceTrackEpoch, "chunk track epoch", 256) }),
    },
    sourceTrackClass,
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
    sessionId: text(assignment.sessionId, "session ID"),
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

export function validateFinalizeAssignment(value: unknown, configuredMaxTtlMs = 15 * 60_000, maxChunks = 50): FinalizeAssignment {
  const assignment = row(value, "finalize assignment");
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
    const meetingStartMs = integer(source.meetingStartMs ?? source.meeting_start_ms, "finalize chunk meeting start");
    const meetingEndMs = integer(source.meetingEndMs ?? source.meeting_end_ms, "finalize chunk meeting end");
    if (!Number.isSafeInteger(meetingStartMs) || !Number.isSafeInteger(meetingEndMs) || meetingEndMs <= meetingStartMs) throw new AssignmentError("finalize chunk meeting timing is invalid");
    const chunk: FinalizeChunkAssignment = {
      chunkId,
      inputUrl,
      inputUrlExpiresAt,
      inputContentType: "application/json",
      inputSizeBytes,
      inputSha256,
      meetingStartMs,
      meetingEndMs,
    };
    return chunk;
  });
  const outputPutUrl = expiringUrl(assignment.outputPutUrl ?? assignment.output_put_url ?? assignment.finalPutUrl ?? assignment.final_put_url, "final result upload URL", configuredMaxTtlMs);
  const outputPutUrlExpiresAt = isoDate(assignment.outputPutUrlExpiresAt ?? assignment.output_put_url_expires_at ?? assignment.finalPutUrlExpiresAt ?? assignment.final_put_url_expires_at, "final result upload expiry");
  const outputContentType = assignment.outputContentType ?? assignment.output_content_type;
  if (outputContentType !== "application/json") throw new AssignmentError("final result content type is invalid");
  const sessionValue = assignment.sessionId ?? assignment.session_id;
  const attempt = integer(assignment.attempt, "finalize attempt");
  if (!Number.isSafeInteger(attempt)) throw new AssignmentError("finalize attempt is invalid");
  return {
    jobId: text(assignment.jobId ?? assignment.job_id, "finalize job ID"),
    transcriptId: text(assignment.transcriptId ?? assignment.transcript_id, "transcript ID"),
    ...(sessionValue === undefined ? {} : { sessionId: text(sessionValue, "session ID") }),
    attempt,
    leaseToken: text(assignment.leaseToken ?? assignment.lease_token, "finalize lease token", 2_048),
    leaseExpiresAt: isoDate(assignment.leaseExpiresAt ?? assignment.lease_expires_at, "finalize lease expiry"),
    chunks,
    outputPutUrl,
    outputPutUrlExpiresAt,
    outputContentType: "application/json",
  };
}
