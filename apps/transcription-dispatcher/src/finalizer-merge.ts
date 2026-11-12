import { transcriptLanguageValue } from "@chalk/transcript-language";
import { AssignmentError } from "./errors.js";
import { MAX_FINAL_CUES, validateChunkDocument } from "./finalizer-chunk-validation.js";
import { MAX_FINALIZER_CHUNKS } from "./finalizer-limits.js";
import type { FinalizeChunkAssignment, ManifestIdentity } from "./assignment-types.js";
import type { NormalizedCue, NormalizedTranscriptDocument } from "./transcript-types.js";

const MAX_TEXT_CHARS = 50_000;
const AUTO_LANGUAGE = { mode: "auto" } as const;

export interface ChunkDocument {
  assignment: FinalizeChunkAssignment;
  document: NormalizedTranscriptDocument;
}

interface MergeOptions {
  jobId: string;
  episodeId: string;
  attempt: number;
  chunks: readonly ChunkDocument[];
  maxTextChars?: number;
}

type ChunkCue = NormalizedCue & { readonly chunkId: string };

/** What the chunks add up to. Each field says what it holds when a chunk is silent about it. */
interface Totals {
  providers: Set<NormalizedTranscriptDocument["provider"]>;
  models: Set<string>;
  versionContracts: Set<string>;
  languages: Set<string>;
  measuredAudioMs: number;
  observedDurationMs: number | undefined;
  reportedCostUsd: number;
  everyChunkReportsCost: boolean;
  segmentCount: number;
  wordCount: number;
  confidenceTotal: number;
  confidenceWeight: number;
}

/**
 * Merge accepted chunk documents without trusting their order or metadata.
 * Different source tracks may share a timeline. Their intersecting cues are
 * retained and explicitly marked as overlap in the final document.
 */
export function mergeTranscriptDocuments(options: MergeOptions): NormalizedTranscriptDocument {
  if (options.chunks.length === 0 || options.chunks.length > MAX_FINALIZER_CHUNKS) throw new AssignmentError("finalize chunk count is invalid");
  const chunkIds = new Set(options.chunks.map((result) => result.assignment.chunkId));
  if (chunkIds.size !== options.chunks.length) throw new AssignmentError("finalize chunk IDs are duplicated");
  const ordered = [...options.chunks].sort(compareChunks);
  const transcriptLanguage = ordered[0]?.document.transcriptLanguage ?? AUTO_LANGUAGE;
  const totals = emptyTotals();
  const cues: ChunkCue[] = [];
  for (const result of ordered) {
    const document = validateChunkDocument(result.document, result.assignment, options.episodeId, options.maxTextChars ?? MAX_TEXT_CHARS);
    if (document.provider === "mixed") throw new AssignmentError("finalize chunk provider summary is invalid");
    if (transcriptLanguageValue(document.transcriptLanguage ?? AUTO_LANGUAGE) !== transcriptLanguageValue(transcriptLanguage)) throw new AssignmentError("finalize transcript language modes differ");
    addDocument(totals, document);
    for (const cue of document.cues) cues.push({ ...cue, chunkId: result.assignment.chunkId });
  }
  if (cues.length > MAX_FINAL_CUES) throw new AssignmentError("finalize cue bound exceeded");
  cues.sort(compareCues);
  markCrossChunkOverlaps(cues);
  return finalDocument(options, transcriptLanguage, totals, cues);
}

function emptyTotals(): Totals {
  return {
    providers: new Set(),
    models: new Set(),
    versionContracts: new Set(),
    languages: new Set(),
    measuredAudioMs: 0,
    observedDurationMs: undefined,
    reportedCostUsd: 0,
    everyChunkReportsCost: true,
    segmentCount: 0,
    wordCount: 0,
    confidenceTotal: 0,
    confidenceWeight: 0,
  };
}

function addDocument(totals: Totals, document: NormalizedTranscriptDocument): void {
  totals.providers.add(document.provider);
  totals.models.add(document.model);
  totals.versionContracts.add(document.versionContract);
  if (document.language !== undefined) totals.languages.add(document.language);
  totals.measuredAudioMs = boundedSum(totals.measuredAudioMs, document.measuredAudioMs, "finalize measured duration");
  if (document.providerObservedDurationMs !== undefined) totals.observedDurationMs = boundedSum(totals.observedDurationMs ?? 0, document.providerObservedDurationMs, "finalize provider duration");
  if (document.providerReportedCostUsd === undefined) totals.everyChunkReportsCost = false;
  else totals.reportedCostUsd += document.providerReportedCostUsd;
  const quality = document.quality;
  if (!quality) return;
  totals.segmentCount = boundedSum(totals.segmentCount, quality.segmentCount, "finalize segment count");
  totals.wordCount = boundedSum(totals.wordCount, quality.wordCount, "finalize word count");
  if (quality.meanConfidence === undefined) return;
  const weight = Math.max(quality.segmentCount, 1);
  totals.confidenceTotal += quality.meanConfidence * weight;
  totals.confidenceWeight += weight;
}

function finalDocument(options: MergeOptions, transcriptLanguage: NonNullable<NormalizedTranscriptDocument["transcriptLanguage"]>, totals: Totals, cues: readonly ChunkCue[]): NormalizedTranscriptDocument {
  const hasQuality = totals.segmentCount > 0 || totals.wordCount > 0 || totals.confidenceWeight > 0;
  const language = onlyValue(totals.languages);
  return {
    schemaVersion: "transcript.v1",
    transcriptLanguage,
    jobId: options.jobId,
    episodeId: options.episodeId,
    cues: cues.map(({ chunkId: _chunkId, ...cue }) => cue),
    ...(language === undefined ? {} : { language }),
    provider: onlyValue(totals.providers) ?? "mixed",
    model: onlyValue(totals.models) ?? "mixed",
    versionContract: onlyValue(totals.versionContracts) ?? "mixed",
    attempt: options.attempt,
    measuredAudioMs: totals.measuredAudioMs,
    ...(totals.observedDurationMs === undefined ? {} : { providerObservedDurationMs: totals.observedDurationMs }),
    ...(totals.everyChunkReportsCost ? { providerReportedCostUsd: totals.reportedCostUsd } : {}),
    ...(hasQuality
      ? {
          quality: {
            segmentCount: totals.segmentCount,
            wordCount: totals.wordCount,
            ...(totals.confidenceWeight > 0 ? { meanConfidence: totals.confidenceTotal / totals.confidenceWeight } : {}),
          },
        }
      : {}),
  };
}

function onlyValue<T>(values: ReadonlySet<T>): T | undefined {
  return values.size === 1 ? [...values][0] : undefined;
}

interface Reach {
  chunkId: string;
  endMs: number;
}

/**
 * A cue overlaps when a cue from another chunk starts before it ends and ends
 * after it starts. The cues are sorted by start, so "everything that starts
 * before this cue ends" is a prefix. Each prefix needs only the two chunks that
 * reach furthest: one of them is foreign to any cue.
 */
function markCrossChunkOverlaps(cues: ChunkCue[]): void {
  const reachByPrefix: Reach[][] = [];
  let furthest: Reach[] = [];
  for (const cue of cues) {
    furthest = extendReach(furthest, cue.chunkId, cue.endMs);
    reachByPrefix.push(furthest);
  }
  for (const cue of cues) {
    const prefixLength = countStartingBefore(cues, cue.endMs);
    const foreign = reachByPrefix[prefixLength - 1]?.find((reach) => reach.chunkId !== cue.chunkId);
    if (foreign && foreign.endMs > cue.startMs) cue.overlap = true;
  }
}

function extendReach(furthest: readonly Reach[], chunkId: string, endMs: number): Reach[] {
  const previousEnd = furthest.find((reach) => reach.chunkId === chunkId)?.endMs ?? endMs;
  const others = furthest.filter((reach) => reach.chunkId !== chunkId);
  return [...others, { chunkId, endMs: Math.max(previousEnd, endMs) }].sort((left, right) => right.endMs - left.endMs).slice(0, 2);
}

function countStartingBefore(sortedCues: readonly ChunkCue[], endMs: number): number {
  let low = 0;
  let high = sortedCues.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((sortedCues[middle] as ChunkCue).startMs < endMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

function boundedSum(left: number, right: number, label: string): number {
  if (!Number.isSafeInteger(right) || right < 0 || !Number.isSafeInteger(left) || left > Number.MAX_SAFE_INTEGER - right) throw new AssignmentError(`${label} is invalid`);
  return left + right;
}

function compareChunks(left: ChunkDocument, right: ChunkDocument): number {
  return left.assignment.episodeStartMs - right.assignment.episodeStartMs || left.assignment.episodeEndMs - right.assignment.episodeEndMs || left.assignment.chunkId.localeCompare(right.assignment.chunkId);
}

function compareCues(left: ChunkCue, right: ChunkCue): number {
  return left.startMs - right.startMs || left.endMs - right.endMs || identityKey(left.identity).localeCompare(identityKey(right.identity)) || left.trackClass.localeCompare(right.trackClass) || left.text.localeCompare(right.text) || left.chunkId.localeCompare(right.chunkId) || left.attempt - right.attempt;
}

function identityKey(value: ManifestIdentity): string {
  return `${value.kind}\u0000${value.participantRef}\u0000${value.participantGeneration}\u0000${value.trackId}\u0000${value.trackEpoch}`;
}
