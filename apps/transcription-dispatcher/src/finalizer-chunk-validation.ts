import { parseTranscriptLanguageMode } from "@chalk/transcript-language";
import { AssignmentError } from "./errors.js";
import type { FinalizeChunkAssignment, ManifestIdentity } from "./assignment-types.js";
import type { ProviderResult } from "./provider-types.js";
import type { NormalizedCue, NormalizedTranscriptDocument } from "./transcript-types.js";

export const MAX_FINAL_CUES = 100_000;
const MAX_REPORTED_COST_USD = 1_000;

function check(condition: boolean, message: string): void {
  if (!condition) throw new AssignmentError(message);
}

function isObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown, max = 512): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isCount(value: unknown): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isUnitInterval(value: unknown): boolean {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function isProvider(value: unknown): value is ProviderResult["provider"] {
  return value === "deepinfra" || value === "cloudflare" || value === "openrouter";
}

/**
 * Accept one chunk result for merging. The document came from storage, so
 * nothing in it is trusted: identity, bounds and metadata must all agree with
 * the chunk assignment. Blank cues are dropped instead of failing the job.
 */
export function validateChunkDocument(value: NormalizedTranscriptDocument, chunk: FinalizeChunkAssignment, expectedEpisodeId: string, maxTextChars: number): NormalizedTranscriptDocument {
  check(isObject(value), "finalize chunk document is invalid");
  if (value.transcriptLanguage !== undefined) parseTranscriptLanguageMode(value.transcriptLanguage);
  check(value.schemaVersion === "transcript.v1", "finalize schema drift");
  check(isNonEmptyText(value.jobId), "finalize source job ID is invalid");
  check(typeof value.episodeId === "string" && value.episodeId.length > 0 && value.episodeId === expectedEpisodeId, "finalize identity metadata conflicts");
  check(isProvider(value.provider), "finalize provider is invalid");
  check(isNonEmptyText(value.model), "finalize model is invalid");
  check(isNonEmptyText(value.versionContract), "finalize version contract is invalid");
  check(isCount(value.attempt), "finalize attempt is invalid");
  validateMeasurements(value, chunk.episodeEndMs - chunk.episodeStartMs);
  check(value.language === undefined || isNonEmptyText(value.language, 64), "finalize language is invalid");
  check(Array.isArray(value.cues) && value.cues.length <= MAX_FINAL_CUES, "finalize cues are invalid");
  const cues = value.cues.filter((cue) => !isObject(cue) || typeof cue.text !== "string" || cue.text.trim().length > 0);
  for (const cue of cues) {
    validateCue(cue, chunk, maxTextChars);
    check(cue.provider === value.provider && cue.model === value.model && cue.versionContract === value.versionContract, "finalize cue metadata conflicts");
  }
  if (value.quality !== undefined) validateQuality(value.quality);
  return cues.length === value.cues.length ? value : { ...value, cues };
}

function validateMeasurements(value: NormalizedTranscriptDocument, chunkDurationMs: number): void {
  check(isCount(value.measuredAudioMs) && value.measuredAudioMs <= chunkDurationMs, "finalize measured duration is invalid");
  const observed = value.providerObservedDurationMs;
  check(observed === undefined || (isCount(observed) && observed <= chunkDurationMs), "finalize provider duration is invalid");
  check(value.billedAudioSeconds === undefined, "finalize billing claim is not authoritative");
  const cost = value.providerReportedCostUsd;
  check(cost === undefined || (Number.isFinite(cost) && cost >= 0 && cost <= MAX_REPORTED_COST_USD), "finalize reported cost is invalid");
}

function validateCue(cue: NormalizedCue, chunk: FinalizeChunkAssignment, maxTextChars: number): void {
  validateCueBounds(cue, chunk);
  check(typeof cue.text === "string" && cue.text.length > 0 && cue.text.length <= maxTextChars, "finalize cue text is invalid");
  check(cue.trackClass === "microphone", "finalize cue track class is invalid");
  validateIdentity(cue.identity);
  check(isNonEmptyText(cue.displayNameSnapshot, 256), "finalize display name is invalid");
  check(typeof cue.overlap === "boolean", "finalize cue overlap is invalid");
  check(isProvider(cue.provider), "finalize cue provider is invalid");
  check(isNonEmptyText(cue.model), "finalize cue model is invalid");
  check(isNonEmptyText(cue.versionContract), "finalize cue version contract is invalid");
  check(isCount(cue.attempt), "finalize cue attempt is invalid");
  if (cue.quality === undefined) return;
  check(isObject(cue.quality), "finalize cue quality is invalid");
  check(cue.quality.confidence === undefined || isUnitInterval(cue.quality.confidence), "finalize cue confidence is invalid");
}

function validateCueBounds(cue: NormalizedCue, chunk: FinalizeChunkAssignment): void {
  check(isObject(cue), "finalize cue bounds are invalid");
  const safeBounds = [cue.startMs, cue.endMs, chunk.episodeStartMs, chunk.episodeEndMs].every((ms) => Number.isSafeInteger(ms));
  check(safeBounds && cue.startMs >= chunk.episodeStartMs && cue.endMs <= chunk.episodeEndMs && cue.endMs > cue.startMs, "finalize cue bounds are invalid");
}

function validateIdentity(value: ManifestIdentity): void {
  check(isObject(value) && value.kind === "participant", "finalize cue identity is invalid");
  const complete = isNonEmptyText(value.participantRef, Infinity) && Number.isSafeInteger(value.participantGeneration) && value.participantGeneration >= 1 && isNonEmptyText(value.trackId, Infinity) && isNonEmptyText(value.trackEpoch, Infinity);
  check(complete, "finalize participant identity is incomplete");
}

function validateQuality(value: NonNullable<NormalizedTranscriptDocument["quality"]>): void {
  check(isObject(value), "finalize quality is invalid");
  check(isCount(value.segmentCount) && isCount(value.wordCount), "finalize quality counts are invalid");
  check(value.meanConfidence === undefined || isUnitInterval(value.meanConfidence), "finalize quality confidence is invalid");
}
