import type { CLOUDFLARE_MODEL, DEEPINFRA_MODEL } from "./models.js";
import type { ClaimResponse, CleanupAssignment, FinalizeClaimResponse } from "./assignment-types.js";
import type { ProviderPolicy, ProviderResult, TranscriptProviderSummary, TranscriptionProvider } from "./provider-types.js";

export interface JourneyContext {
  journeyId: string;
  traceparent?: string;
  tracestate?: string;
}

export interface ReleaseConfig {
  codeswitchProvider?: "mai";
  openRouterToken?: string;
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
    adapterContractVersion?: string;
    corpusDigest?: string;
    model: typeof DEEPINFRA_MODEL;
  };
  cloudflare:
    | { enabled: false }
    | {
        enabled: true;
        token: string;
        accountId: string;
        modelSlug: typeof CLOUDFLARE_MODEL;
        adapterContractVersion: string;
        corpusDigest: string;
      };
  provider: ProviderPolicy;
}

/** A claimed job attempt. The control plane fences every request that carries one. */
export interface Lease {
  jobId: string;
  attempt: number;
  leaseToken: string;
}

/** Journey context and cancellation that go with every control request. */
export interface ControlCall {
  context: JourneyContext;
  signal?: AbortSignal;
}

export interface CompletionInput extends Lease {
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

export interface FinalizeCompletionInput extends Lease {
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

export interface RetryInput extends Lease {
  errorCode: string;
  retryAt?: string;
  terminal?: boolean;
}

export interface ControlApi {
  claim(input: { limit: number } & ControlCall): Promise<ClaimResponse>;
  heartbeat(input: { assignment: Lease } & ControlCall): Promise<void>;
  retry(input: RetryInput & ControlCall): Promise<void>;
  complete(input: CompletionInput & ControlCall): Promise<void>;
  claimFinalize(input: { limit: number } & ControlCall): Promise<FinalizeClaimResponse>;
  completeFinalize(input: FinalizeCompletionInput & ControlCall): Promise<void>;
  retryFinalize(input: RetryInput & ControlCall): Promise<void>;
  claimCleanup(input: { limit: number } & ControlCall): Promise<{ assignments: CleanupAssignment[] }>;
  completeCleanup(input: { assignment: CleanupAssignment } & ControlCall): Promise<void>;
  retryCleanup(input: { assignment: CleanupAssignment; errorCode: string; terminal?: boolean } & ControlCall): Promise<void>;
}

export interface DispatcherContext {
  getRemainingTimeInMillis(): number;
}

export interface DispatcherEvent {
  source?: "wake" | "reconcile" | "finalize" | "cleanup" | "eventbridge.scheduler";
  journeyId?: string;
  traceparent?: string;
  tracestate?: string;
}

export interface DispatcherDependencies {
  config: ReleaseConfig;
  control: ControlApi;
  codeswitch?: TranscriptionProvider;
  primary?: TranscriptionProvider;
  fallback?: TranscriptionProvider;
  fetch: typeof fetch;
  logger?: DispatcherLogger;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export interface DispatcherLogger {
  info(event: string, fields?: Record<string, string | number | boolean>): void;
  warn(event: string, fields?: Record<string, string | number | boolean>): void;
}
