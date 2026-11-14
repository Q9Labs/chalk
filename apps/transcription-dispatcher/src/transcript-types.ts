import type { TranscriptLanguageMode } from "@chalk/transcript-language";
import type { ManifestIdentity, TrackClass } from "./assignment-types.js";
import type { ProviderResult, TranscriptProviderSummary } from "./provider-types.js";

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
  transcriptLanguage?: TranscriptLanguageMode;
  schemaVersion: "transcript.v1";
  jobId: string;
  episodeId: string;
  cues: NormalizedCue[];
  language?: string;
  provider: TranscriptProviderSummary;
  model: string;
  versionContract: string;
  providerIdentity?: ProviderResult["providerIdentity"];
  executionIdentity?: string;
  attempt: number;
  measuredAudioMs: number;
  providerObservedDurationMs?: number;
  billedAudioSeconds?: number;
  providerReportedCostUsd?: number;
  quality?: ProviderResult["quality"];
}
