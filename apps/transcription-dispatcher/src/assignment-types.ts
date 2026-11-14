import type { TranscriptLanguageMode } from "@chalk/transcript-language";

export type TrackClass = "microphone";

export interface ManifestIdentity {
  kind: "participant";
  participantRef: string;
  participantGeneration: number;
  trackId: string;
  trackEpoch: string;
}

export interface SpeakerTurn {
  startMs: number;
  endMs: number;
  identity: ManifestIdentity;
  trackClass: TrackClass;
  displayNameSnapshot: string;
  overlap: boolean;
}

export interface SpeakerTurnManifest {
  schemaVersion: "recording-transcription-source.v1";
  tenantId: string;
  recordingId: string;
  episodeId: string;
  captureEpoch: number;
  durationMs: number;
  timebase: "recording_relative_ms";
  presentationSha256: string;
  turns: SpeakerTurn[];
}

export interface ChunkAssignment {
  chunkId: string;
  inputObjectKey: string;
  inputUrl: string;
  inputUrlExpiresAt: string;
  inputContentType: string;
  inputSizeBytes: number;
  inputSha256: string;
  episodeStartMs: number;
  episodeEndMs: number;
  sourceStartMs: number;
  sourceEndMs: number;
  chunkIndex: number;
  generation: number;
  allocationId: string;
  objectVersion: string;
  objectEtag: string;
  sourceIdentity: ManifestIdentity;
  sourceTrackClass: TrackClass;
  displayNameSnapshot: string;
  overlap: boolean;
}

export interface ManifestAssignment {
  inputUrl: string;
  expiresAt: string;
  contentType: "application/json";
  sizeBytes: number;
  sha256: string;
}

export interface TranscriptionAssignment {
  transcriptLanguage?: TranscriptLanguageMode;
  jobId: string;
  tenantId: string;
  episodeId: string;
  recordingId: string;
  presentationSha256: string;
  sourceExpiresAt: string;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
  chunk: ChunkAssignment;
  manifest: ManifestAssignment;
  outputPutUrl: string;
  outputPutUrlExpiresAt: string;
  outputContentType: "application/json";
}

export interface CleanupAssignment {
  jobId: string;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
  deleteUrl: string;
  deleteUrlExpiresAt: string;
}

/** A private, bounded GET authority for one normalized transcript chunk result. */
export interface FinalizeChunkAssignment {
  chunkId: string;
  inputUrl: string;
  inputUrlExpiresAt: string;
  inputContentType: "application/json";
  inputSizeBytes: number;
  inputSha256: string;
  episodeStartMs: number;
  episodeEndMs: number;
}

/** Fenced work to compose accepted chunk results into one final transcript. */
export interface FinalizeAssignment {
  jobId: string;
  transcriptId: string;
  episodeId: string;
  attempt: number;
  leaseToken: string;
  leaseExpiresAt: string;
  chunks: FinalizeChunkAssignment[];
  outputPutUrl: string;
  outputPutUrlExpiresAt: string;
  outputContentType: "application/json";
}

export interface ClaimResponse {
  assignments: TranscriptionAssignment[];
}

export interface FinalizeClaimResponse {
  assignments: FinalizeAssignment[];
}
