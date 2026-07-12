export type FetchLike = typeof fetch;

export interface JourneyContext {
  journeyId: string;
  traceparent?: string;
  tracestate?: string;
}

export interface ProviderSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
  confidence?: number;
}

export interface ProviderWord {
  startSeconds: number;
  endSeconds: number;
  word: string;
  confidence?: number;
}

export interface ProviderResult {
  text: string;
  language?: string;
  durationMs?: number;
  segments: ProviderSegment[];
  words?: ProviderWord[];
  provider: "deepinfra" | "cloudflare";
  model: string;
  versionContract: string;
  executionIdentity?: string;
  providerIdentity?: {
    requestId?: string;
    model?: string;
  };
  quality?: {
    meanConfidence?: number;
    segmentCount: number;
    wordCount: number;
  };
}

export type TranscriptProviderSummary = ProviderResult["provider"] | "mixed";

export interface ProviderRequest {
  audio: Uint8Array;
  contentType: string;
  chunkId: string;
  signal?: AbortSignal;
}

export interface TranscriptionProvider {
  readonly name: "deepinfra" | "cloudflare";
  transcribe(request: ProviderRequest): Promise<ProviderResult>;
}

export type TrackClass = "microphone" | "screen-share" | "system-audio" | "unknown";

export interface ManifestIdentity {
  kind: "participant" | "shared" | "unknown";
  participantId?: string;
  trackEpoch?: string;
}

export interface SpeakerTurn {
  startMs: number;
  endMs: number;
  identity: ManifestIdentity;
  trackClass: TrackClass;
  displayNameSnapshot?: string;
  overlap: boolean;
}

export interface SpeakerTurnManifest {
  schemaVersion: string;
  turns: SpeakerTurn[];
}

export interface ChunkAssignment {
  chunkId: string;
  inputUrl: string;
  inputUrlExpiresAt: string;
  inputContentType: string;
  inputSizeBytes: number;
  inputSha256: string;
  meetingStartMs: number;
  meetingEndMs: number;
  sourceIdentity: ManifestIdentity;
  sourceTrackClass: TrackClass;
}

export interface ManifestAssignment {
  inputUrl: string;
  expiresAt: string;
  contentType: "application/json";
  sizeBytes: number;
  sha256: string;
}

export interface TranscriptionAssignment {
  jobId: string;
  sessionId: string;
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
  meetingStartMs: number;
  meetingEndMs: number;
}

/** Fenced work to compose accepted chunk results into one final transcript. */
export interface FinalizeAssignment {
  jobId: string;
  transcriptId: string;
  sessionId?: string;
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

export interface NormalizedCue {
  startMs: number;
  endMs: number;
  identity: ManifestIdentity;
  trackClass: TrackClass;
  displayNameSnapshot?: string;
  text: string;
  overlap: boolean;
  provider: ProviderResult["provider"];
  model: string;
  versionContract: string;
  attempt: number;
  quality?: {
    confidence?: number;
  };
}

export interface NormalizedTranscriptDocument {
  schemaVersion: "transcript.v1";
  jobId: string;
  sessionId: string;
  cues: NormalizedCue[];
  language?: string;
  provider: TranscriptProviderSummary;
  model: string;
  versionContract: string;
  attempt: number;
  measuredAudioMs: number;
  providerObservedDurationMs?: number;
  billedAudioSeconds?: number;
  quality?: ProviderResult["quality"];
}

export interface ProviderPolicy {
  timeoutMs: number;
  maxAudioBytes: number;
  maxAudioSeconds: number;
  maxResponseBytes: number;
  maxTextChars: number;
  maxSegments: number;
  maxWords: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  circuitFailureThreshold: number;
  circuitCooldownMs: number;
}

export interface ReleaseConfig {
  environment: string;
  releaseId: string;
  controlApiAudience: string;
  controlApiBaseUrl: string;
  maxBatch: number;
  concurrency: number;
  timeoutReserveMs: number;
  privacyGateAccepted: boolean;
  deepInfra: {
    enabled: boolean;
    token?: string;
    executionIdentityPin?: string;
    modelVersionPin?: string;
    model: "openai/whisper-large-v3-turbo";
  };
  cloudflare: {
    token: string;
    accountId: string;
    modelSlug: "@cf/openai/whisper-large-v3-turbo";
    adapterContractVersion: string;
    corpusDigest: string;
  };
  provider: ProviderPolicy;
}

export interface WorkloadHeaders {
  authorization: string;
  [name: string]: string;
}

export interface CompletionInput {
  jobId: string;
  attempt: number;
  leaseToken: string;
  checksumSha256: string;
  sizeBytes: number;
  contentType: "application/json";
  provider: ProviderResult["provider"];
  model: string;
  versionContract: string;
  executionIdentity?: string;
  providerRequestId?: string;
  language?: string;
  measuredAudioMs: number;
  providerObservedDurationMs?: number;
  billedAudioSeconds?: number;
  quality?: ProviderResult["quality"];
}

export interface FinalizeCompletionInput {
  jobId: string;
  attempt: number;
  leaseToken: string;
  checksumSha256: string;
  sizeBytes: number;
  contentType: "application/json";
  provider: TranscriptProviderSummary;
  model: string;
  versionContract: string;
  languages: string[];
  executionIdentity?: string;
  providerRequestId?: string;
  quality?: ProviderResult["quality"];
}

export interface RetryInput {
  jobId: string;
  attempt: number;
  leaseToken: string;
  errorCode: string;
  retryAt?: string;
  terminal?: boolean;
}

export interface ControlApi {
  claim(input: { limit: number; context: JourneyContext; signal?: AbortSignal }): Promise<ClaimResponse>;
  heartbeat(input: { assignment: TranscriptionAssignment; context: JourneyContext; signal?: AbortSignal }): Promise<void>;
  heartbeatFinalize?(input: { assignment: FinalizeAssignment; context: JourneyContext; signal?: AbortSignal }): Promise<void>;
  retry(input: RetryInput & { context: JourneyContext; signal?: AbortSignal }): Promise<void>;
  complete(input: CompletionInput & { context: JourneyContext; signal?: AbortSignal }): Promise<void>;
  claimFinalize?(input: { limit: number; context: JourneyContext; signal?: AbortSignal }): Promise<FinalizeClaimResponse>;
  completeFinalize?(input: FinalizeCompletionInput & { context: JourneyContext; signal?: AbortSignal }): Promise<void>;
  retryFinalize?(input: { jobId: string; attempt: number; leaseToken: string; errorCode: string; retryAt?: string; terminal?: boolean; context: JourneyContext; signal?: AbortSignal }): Promise<void>;
  claimCleanup?(input: { limit: number; context: JourneyContext; signal?: AbortSignal }): Promise<{ assignments: CleanupAssignment[] }>;
  completeCleanup?(input: { assignment: CleanupAssignment; context: JourneyContext; signal?: AbortSignal }): Promise<void>;
  retryCleanup?(input: { assignment: CleanupAssignment; errorCode: string; terminal?: boolean; context: JourneyContext; signal?: AbortSignal }): Promise<void>;
}

export interface DispatcherContext {
  getRemainingTimeInMillis(): number;
}

export interface DispatcherEvent {
  source?: "wake" | "reconcile" | "finalize" | "cleanup" | "eventbridge.scheduler";
  kind?: string;
  journeyId?: string;
  traceparent?: string;
  tracestate?: string;
}

export interface DispatcherLogger {
  info(event: string, fields?: Record<string, string | number | boolean>): void;
  warn(event: string, fields?: Record<string, string | number | boolean>): void;
}
