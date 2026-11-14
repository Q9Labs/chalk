import { AssignmentError } from "./errors.js";
import type { ChunkAssignment, SpeakerTurnManifest, TranscriptionAssignment } from "./assignment-types.js";
import { exactRow, text, optionalText, nonnegative, integer, positiveInteger, checksum } from "./wire-fields.js";

const MAX_CHUNK_DURATION_MS = 15 * 60_000;
const MAX_CHUNKS = 10_000;

const MANIFEST_KEYS = ["schema_version", "tenant_id", "recording_id", "episode_id", "capture_epoch", "duration_ms", "timebase", "presentation_sha256", "producer", "chunk_policy", "chunks"];
const PRODUCER_KEYS = ["render_job_id", "attempt_count", "fencing_generation", "envelope_sha256"];
const POLICY_KEYS = ["version", "max_duration_ms", "context_ms", "codec", "sample_rate_hz", "channels"];
const CHUNK_KEYS = ["chunk_id", "chunk_index", "generation", "participant_ref", "participant_generation", "display_name_snapshot", "identity_kind", "track_id", "track_epoch", "track_class", "start_ms", "end_ms", "source_start_ms", "source_end_ms", "overlap", "storage"];
const STORAGE_KEYS = ["allocation_id", "object_key", "object_version", "etag", "content_type", "byte_size", "sha256"];

interface ManifestChunk {
  chunkId: string;
  chunkIndex: number;
  generation: number;
  participantRef: string;
  participantGeneration: number;
  displayNameSnapshot: string;
  trackId: string;
  trackEpoch: string;
  startMs: number;
  endMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  overlap: boolean;
  allocationId: string;
  objectKey: string;
  objectVersion: string;
  objectEtag: string;
  byteSize: number;
  sha256: string;
}

/** Parse the speaker-turn manifest and prove it describes the assigned chunk. */
export function validateSpeakerTurnManifest(value: unknown, assignment: TranscriptionAssignment): SpeakerTurnManifest {
  const manifest = exactRow(value, "manifest", MANIFEST_KEYS);
  if (manifest.schema_version !== "recording-transcription-source.v1") throw new AssignmentError("manifest schema is invalid");
  const tenantId = text(manifest.tenant_id, "manifest tenant ID");
  const recordingId = text(manifest.recording_id, "manifest recording ID");
  const episodeId = text(manifest.episode_id, "manifest episode ID");
  const captureEpoch = positiveInteger(manifest.capture_epoch, "manifest capture epoch");
  const durationMs = positiveInteger(manifest.duration_ms, "manifest duration");
  if (manifest.timebase !== "recording_relative_ms") throw new AssignmentError("manifest timebase is invalid");
  const presentationSha256 = checksum(manifest.presentation_sha256, "manifest presentation checksum");
  checkProducer(manifest.producer);
  const maxDurationMs = parseChunkPolicy(manifest.chunk_policy);
  const chunks = parseChunks(manifest.chunks, durationMs, maxDurationMs);

  if (tenantId !== assignment.tenantId || recordingId !== assignment.recordingId || episodeId !== assignment.episodeId || presentationSha256 !== assignment.presentationSha256) {
    throw new AssignmentError("manifest source authority does not match the assignment");
  }
  const selected = chunks.find((chunk) => chunk.chunkId === assignment.chunk.chunkId);
  if (!selected || !describesChunk(selected, assignment.chunk)) throw new AssignmentError("manifest chunk authority does not match the assignment");
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

/** The producer block is checked for shape only; nothing in it reaches the transcript. */
function checkProducer(value: unknown): void {
  const producer = exactRow(value, "manifest producer", PRODUCER_KEYS);
  text(producer.render_job_id, "manifest render job ID");
  positiveInteger(producer.attempt_count, "manifest render attempt");
  positiveInteger(producer.fencing_generation, "manifest fencing generation");
  checksum(producer.envelope_sha256, "manifest envelope checksum");
}

/** Returns the longest chunk the policy allows. */
function parseChunkPolicy(value: unknown): number {
  const policy = exactRow(value, "manifest chunk policy", POLICY_KEYS);
  text(policy.version, "manifest chunk policy version", 128);
  const maxDurationMs = positiveInteger(policy.max_duration_ms, "manifest maximum chunk duration");
  const contextMs = nonnegative(policy.context_ms, "manifest chunk context");
  const supportedAudio = policy.codec === "flac" && policy.sample_rate_hz === 16_000 && policy.channels === 1;
  if (maxDurationMs > MAX_CHUNK_DURATION_MS || contextMs > maxDurationMs || !supportedAudio) throw new AssignmentError("manifest chunk policy is invalid");
  return maxDurationMs;
}

function parseChunks(value: unknown, durationMs: number, maxDurationMs: number): ManifestChunk[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHUNKS) throw new AssignmentError("manifest chunks are invalid");
  const chunkIds = new Set<string>();
  const allocationIds = new Set<string>();
  return value.map((item, index) => {
    const chunk = parseChunk(item, index, durationMs, maxDurationMs);
    if (chunkIds.has(chunk.chunkId)) throw new AssignmentError("manifest chunk IDs are duplicated");
    chunkIds.add(chunk.chunkId);
    if (allocationIds.has(chunk.allocationId)) throw new AssignmentError("manifest allocation IDs are duplicated");
    allocationIds.add(chunk.allocationId);
    return chunk;
  });
}

function parseChunk(item: unknown, index: number, durationMs: number, maxDurationMs: number): ManifestChunk {
  const chunk = exactRow(item, `manifest chunk ${index}`, CHUNK_KEYS);
  const chunkId = text(chunk.chunk_id, "manifest chunk ID");
  if (integer(chunk.chunk_index, "manifest chunk index") !== index) throw new AssignmentError("manifest chunk order is invalid");
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
  const lengthMs = endMs - startMs;
  if (lengthMs <= 0 || endMs > durationMs || sourceEndMs - sourceStartMs !== lengthMs || lengthMs > maxDurationMs) throw new AssignmentError("manifest chunk timing is invalid");
  if (typeof chunk.overlap !== "boolean") throw new AssignmentError("manifest overlap is invalid");
  const storage = parseStorage(chunk.storage);
  return { chunkId, chunkIndex: index, generation, participantRef, participantGeneration, displayNameSnapshot, trackId, trackEpoch, startMs, endMs, sourceStartMs, sourceEndMs, overlap: chunk.overlap, ...storage };
}

function parseStorage(value: unknown) {
  const storage = exactRow(value, "manifest chunk storage", STORAGE_KEYS);
  const allocationId = text(storage.allocation_id, "manifest allocation ID");
  const objectKey = text(storage.object_key, "manifest object key", 1_024);
  const objectVersion = optionalText(storage.object_version, "manifest object version", 256);
  const objectEtag = text(storage.etag, "manifest object ETag", 256);
  if (storage.content_type !== "audio/flac") throw new AssignmentError("manifest source content type is invalid");
  const byteSize = positiveInteger(storage.byte_size, "manifest source size");
  const sha256 = checksum(storage.sha256, "manifest source checksum");
  return { allocationId, objectKey, objectVersion, objectEtag, byteSize, sha256 };
}

/** Every fact the manifest holds about the chunk must equal what the control plane assigned. */
function describesChunk(selected: ManifestChunk, assigned: ChunkAssignment): boolean {
  const pairs: ReadonlyArray<readonly [unknown, unknown]> = [
    [selected.chunkIndex, assigned.chunkIndex],
    [selected.generation, assigned.generation],
    [selected.startMs, assigned.episodeStartMs],
    [selected.endMs, assigned.episodeEndMs],
    [selected.sourceStartMs, assigned.sourceStartMs],
    [selected.sourceEndMs, assigned.sourceEndMs],
    [selected.participantRef, assigned.sourceIdentity.participantRef],
    [selected.participantGeneration, assigned.sourceIdentity.participantGeneration],
    [selected.trackId, assigned.sourceIdentity.trackId],
    [selected.trackEpoch, assigned.sourceIdentity.trackEpoch],
    [selected.displayNameSnapshot, assigned.displayNameSnapshot],
    [selected.overlap, assigned.overlap],
    [selected.allocationId, assigned.allocationId],
    [selected.objectKey, assigned.inputObjectKey],
    [selected.objectVersion, assigned.objectVersion],
    [selected.objectEtag, assigned.objectEtag],
    [selected.byteSize, assigned.inputSizeBytes],
    [selected.sha256, assigned.inputSha256],
    [assigned.inputContentType, "audio/flac"],
    [assigned.sourceTrackClass, "microphone"],
  ];
  return pairs.every(([left, right]) => left === right);
}
