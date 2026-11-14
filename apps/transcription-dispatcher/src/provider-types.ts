import type { TranscriptLanguageMode } from "@chalk/transcript-language";

export interface ProviderSegment {
  startSeconds: number;
  endSeconds: number;
  text: string;
  confidence?: number;
  useSegmentText?: true;
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
  providerReportedCostUsd?: number;
  segments: ProviderSegment[];
  words?: ProviderWord[];
  provider: "deepinfra" | "cloudflare" | "openrouter";
  model: string;
  versionContract: string;
  executionIdentity?: string;
  providerIdentity?: {
    requestId?: string;
    model?: string;
    modelVersion?: string;
  };
  quality?: {
    meanConfidence?: number;
    segmentCount: number;
    wordCount: number;
  };
}

export type TranscriptProviderSummary = ProviderResult["provider"] | "mixed";

export interface ProviderTimingRepair {
  fieldPath: string;
  startSeconds: number;
  endSeconds: number;
  previousEndSeconds?: number;
}

export interface ProviderRequest {
  transcriptLanguage?: TranscriptLanguageMode;
  audio: Uint8Array;
  contentType: string;
  chunkId: string;
  signal?: AbortSignal;
  onTimingRepair?: (repair: ProviderTimingRepair) => void;
}

export interface TranscriptionProvider {
  readonly name: "deepinfra" | "cloudflare" | "openrouter";
  transcribe(request: ProviderRequest): Promise<ProviderResult>;
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
