import { AssignmentError } from "./errors.js";
import { MAX_FINALIZER_CHUNKS } from "./finalizer-limits.js";
import type { FinalizeChunkAssignment, ManifestIdentity, NormalizedCue, NormalizedTranscriptDocument, ProviderResult } from "./types.js";

const MAX_FINAL_CUES = 100_000;
const MAX_TEXT_CHARS = 50_000;

export interface ChunkDocument {
  assignment: FinalizeChunkAssignment;
  document: NormalizedTranscriptDocument;
}

interface MergeOptions {
  jobId: string;
  sessionId?: string;
  attempt: number;
  chunks: readonly ChunkDocument[];
  maxTextChars?: number;
}

/**
 * Merge accepted chunk documents without trusting their order or metadata.
 * Different source tracks may share a timeline. Their intersecting cues are
 * retained and explicitly marked as overlap in the final document.
 */
export function mergeTranscriptDocuments(options: MergeOptions): NormalizedTranscriptDocument {
  if (options.chunks.length === 0 || options.chunks.length > MAX_FINALIZER_CHUNKS) throw new AssignmentError("finalize chunk count is invalid");
  const chunkIDs = new Set<string>();
  for (const result of options.chunks) {
    if (chunkIDs.has(result.assignment.chunkId)) throw new AssignmentError("finalize chunk IDs are duplicated");
    chunkIDs.add(result.assignment.chunkId);
  }
  const ordered = [...options.chunks].sort((left, right) => left.assignment.meetingStartMs - right.assignment.meetingStartMs || left.assignment.meetingEndMs - right.assignment.meetingEndMs || left.assignment.chunkId.localeCompare(right.assignment.chunkId));
  const providers = new Set<ProviderResult["provider"]>();
  const models = new Set<string>();
  const versionContracts = new Set<string>();
  const maxTextChars = options.maxTextChars ?? MAX_TEXT_CHARS;
  let sessionId: string | undefined = options.sessionId;
  const languages = new Set<string>();
  let measuredAudioMs = 0;
  let providerObservedDurationMs = 0;
  let hasProviderObservedDuration = false;
  const cues: Array<NormalizedCue & { readonly chunkId: string }> = [];
  const quality = {
    segmentCount: 0,
    wordCount: 0,
    confidenceWeightedTotal: 0,
    confidenceWeight: 0,
    hasConfidence: false,
  };

  for (const result of ordered) {
    const document = validateChunkDocument(result.document, result.assignment, sessionId, MAX_FINAL_CUES, maxTextChars);
    sessionId ??= document.sessionId;
    if (document.provider === "mixed") throw new AssignmentError("finalize chunk provider summary is invalid");
    providers.add(document.provider);
    models.add(document.model);
    versionContracts.add(document.versionContract);
    if (document.language !== undefined) languages.add(document.language);
    measuredAudioMs = boundedSum(measuredAudioMs, document.measuredAudioMs, "finalize measured duration");
    if (document.providerObservedDurationMs !== undefined) {
      hasProviderObservedDuration = true;
      providerObservedDurationMs = boundedSum(providerObservedDurationMs, document.providerObservedDurationMs, "finalize provider duration");
    }
    if (document.quality) {
      quality.segmentCount = boundedSum(quality.segmentCount, document.quality.segmentCount, "finalize segment count");
      quality.wordCount = boundedSum(quality.wordCount, document.quality.wordCount, "finalize word count");
      if (document.quality.meanConfidence !== undefined) {
        const weight = document.quality.segmentCount > 0 ? document.quality.segmentCount : 1;
        quality.confidenceWeightedTotal += document.quality.meanConfidence * weight;
        quality.confidenceWeight += weight;
        quality.hasConfidence = true;
      }
    }
    for (const cue of document.cues) cues.push({ ...cue, chunkId: result.assignment.chunkId });
  }
  if (!sessionId || providers.size === 0 || models.size === 0 || versionContracts.size === 0) throw new AssignmentError("finalize metadata is incomplete");
  if (cues.length > MAX_FINAL_CUES) throw new AssignmentError("finalize cue bound exceeded");
  cues.sort(compareCues);
  markCrossChunkOverlaps(cues);
  const outputQuality =
    quality.segmentCount > 0 || quality.wordCount > 0 || quality.hasConfidence
      ? {
          segmentCount: quality.segmentCount,
          wordCount: quality.wordCount,
          ...(quality.hasConfidence && quality.confidenceWeight > 0 ? { meanConfidence: quality.confidenceWeightedTotal / quality.confidenceWeight } : {}),
        }
      : undefined;
  const language = languages.size === 1 ? [...languages][0] : undefined;
  return {
    schemaVersion: "transcript.v1",
    jobId: options.jobId,
    sessionId,
    cues: cues.map(({ chunkId: _chunkId, ...cue }) => cue),
    ...(language === undefined ? {} : { language }),
    provider: providers.size === 1 ? ([...providers][0] as ProviderResult["provider"]) : "mixed",
    model: models.size === 1 ? ([...models][0] as string) : "mixed",
    versionContract: versionContracts.size === 1 ? ([...versionContracts][0] as string) : "mixed",
    attempt: options.attempt,
    measuredAudioMs,
    ...(hasProviderObservedDuration ? { providerObservedDurationMs } : {}),
    ...(outputQuality === undefined ? {} : { quality: outputQuality }),
  };
}

interface OverlapCandidate {
  chunkId: string;
  endMs: number;
}

interface OverlapSummary {
  first?: OverlapCandidate;
  second?: OverlapCandidate;
}

function markCrossChunkOverlaps(cues: Array<NormalizedCue & { readonly chunkId: string }>): void {
  if (cues.length < 2) return;
  const starts = [...new Set(cues.map((cue) => cue.startMs))].sort((left, right) => left - right);
  const leafSummaries = new Map<number, OverlapSummary>();
  for (const cue of cues) {
    const existing = leafSummaries.get(cue.startMs);
    leafSummaries.set(cue.startMs, mergeOverlapSummaries(existing, { first: { chunkId: cue.chunkId, endMs: cue.endMs } }));
  }
  const treeSize = nextPowerOfTwo(starts.length);
  const tree: Array<OverlapSummary | undefined> = Array.from({ length: treeSize * 2 });
  for (let index = 0; index < starts.length; index += 1) tree[treeSize + index] = leafSummaries.get(starts[index] as number);
  for (let index = treeSize - 1; index > 0; index -= 1) tree[index] = mergeOverlapSummaries(tree[index * 2], tree[index * 2 + 1]);

  for (const cue of cues) {
    const count = lowerBound(starts, cue.endMs);
    if (count === 0) continue;
    const summary = queryOverlapPrefix(tree, treeSize, count);
    const foreign = summary.first?.chunkId === cue.chunkId ? summary.second : summary.first;
    if (foreign && foreign.endMs > cue.startMs) cue.overlap = true;
  }
}

function mergeOverlapSummaries(left?: OverlapSummary, right?: OverlapSummary): OverlapSummary {
  const candidates: OverlapCandidate[] = [];
  for (const candidate of [left?.first, left?.second, right?.first, right?.second]) {
    if (!candidate) continue;
    const existing = candidates.find((entry) => entry.chunkId === candidate.chunkId);
    if (existing) {
      if (candidate.endMs > existing.endMs) existing.endMs = candidate.endMs;
    } else {
      candidates.push({ ...candidate });
    }
  }
  candidates.sort((candidate, other) => other.endMs - candidate.endMs || candidate.chunkId.localeCompare(other.chunkId));
  return {
    ...(candidates[0] === undefined ? {} : { first: candidates[0] }),
    ...(candidates[1] === undefined ? {} : { second: candidates[1] }),
  };
}

function queryOverlapPrefix(tree: Array<OverlapSummary | undefined>, treeSize: number, count: number): OverlapSummary {
  let left = treeSize;
  let right = treeSize + count;
  let result: OverlapSummary | undefined;
  while (left < right) {
    if (left % 2 === 1) result = mergeOverlapSummaries(result, tree[left++]);
    if (right % 2 === 1) result = mergeOverlapSummaries(result, tree[--right]);
    left = Math.floor(left / 2);
    right = Math.floor(right / 2);
  }
  return result ?? {};
}

function lowerBound(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((values[middle] as number) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function nextPowerOfTwo(value: number): number {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function validateChunkDocument(value: NormalizedTranscriptDocument, chunk: FinalizeChunkAssignment, expectedSessionId: string | undefined, maxCues: number, maxTextChars: number): NormalizedTranscriptDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssignmentError("finalize chunk document is invalid");
  if (value.schemaVersion !== "transcript.v1") throw new AssignmentError("finalize schema drift");
  boundedText(value.jobId, "finalize source job ID");
  if (typeof value.sessionId !== "string" || value.sessionId.length === 0 || (expectedSessionId !== undefined && value.sessionId !== expectedSessionId)) throw new AssignmentError("finalize identity metadata conflicts");
  if (value.provider !== "deepinfra" && value.provider !== "cloudflare") throw new AssignmentError("finalize provider is invalid");
  boundedText(value.model, "finalize model");
  boundedText(value.versionContract, "finalize version contract");
  if (!Number.isInteger(value.attempt) || value.attempt < 0) throw new AssignmentError("finalize attempt is invalid");
  if (!Number.isInteger(value.measuredAudioMs) || value.measuredAudioMs < 0 || value.measuredAudioMs > chunk.meetingEndMs - chunk.meetingStartMs) throw new AssignmentError("finalize measured duration is invalid");
  if (value.providerObservedDurationMs !== undefined && (!Number.isSafeInteger(value.providerObservedDurationMs) || value.providerObservedDurationMs < 0 || value.providerObservedDurationMs > chunk.meetingEndMs - chunk.meetingStartMs))
    throw new AssignmentError("finalize provider duration is invalid");
  if (value.billedAudioSeconds !== undefined) throw new AssignmentError("finalize billing claim is not authoritative");
  if (value.language !== undefined) boundedText(value.language, "finalize language", 64);
  if (!Array.isArray(value.cues) || value.cues.length > maxCues) throw new AssignmentError("finalize cues are invalid");
  for (const cue of value.cues) {
    validateCue(cue, chunk, maxTextChars);
    if (cue.provider !== value.provider || cue.model !== value.model || cue.versionContract !== value.versionContract) throw new AssignmentError("finalize cue metadata conflicts");
  }
  if (value.quality !== undefined) validateQuality(value.quality);
  return value;
}

function validateCue(cue: NormalizedCue, chunk: FinalizeChunkAssignment, maxTextChars: number): void {
  if (
    !cue ||
    typeof cue !== "object" ||
    Array.isArray(cue) ||
    !Number.isSafeInteger(cue.startMs) ||
    !Number.isSafeInteger(cue.endMs) ||
    !Number.isSafeInteger(chunk.meetingStartMs) ||
    !Number.isSafeInteger(chunk.meetingEndMs) ||
    cue.startMs < chunk.meetingStartMs ||
    cue.endMs > chunk.meetingEndMs ||
    cue.endMs <= cue.startMs
  )
    throw new AssignmentError("finalize cue bounds are invalid");
  if (typeof cue.text !== "string" || cue.text.length === 0 || cue.text.length > maxTextChars) throw new AssignmentError("finalize cue text is invalid");
  if (cue.trackClass !== "microphone" && cue.trackClass !== "screen-share" && cue.trackClass !== "system-audio" && cue.trackClass !== "unknown") throw new AssignmentError("finalize cue track class is invalid");
  validateIdentity(cue.identity);
  if (cue.displayNameSnapshot !== undefined) boundedText(cue.displayNameSnapshot, "finalize display name", 256);
  if (typeof cue.overlap !== "boolean") throw new AssignmentError("finalize cue overlap is invalid");
  if (cue.provider !== "deepinfra" && cue.provider !== "cloudflare") throw new AssignmentError("finalize cue provider is invalid");
  boundedText(cue.model, "finalize cue model");
  boundedText(cue.versionContract, "finalize cue version contract");
  if (!Number.isInteger(cue.attempt) || cue.attempt < 0) throw new AssignmentError("finalize cue attempt is invalid");
  if (cue.quality !== undefined) {
    if (!cue.quality || typeof cue.quality !== "object" || Array.isArray(cue.quality)) throw new AssignmentError("finalize cue quality is invalid");
    if (cue.quality.confidence !== undefined && (typeof cue.quality.confidence !== "number" || cue.quality.confidence < 0 || cue.quality.confidence > 1)) throw new AssignmentError("finalize cue confidence is invalid");
  }
}

function validateIdentity(value: ManifestIdentity): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || (value.kind !== "participant" && value.kind !== "shared" && value.kind !== "unknown")) throw new AssignmentError("finalize cue identity is invalid");
  if (value.kind === "participant") {
    if (typeof value.participantId !== "string" || value.participantId.length === 0 || typeof value.trackEpoch !== "string" || value.trackEpoch.length === 0) throw new AssignmentError("finalize participant identity is incomplete");
  } else if (value.participantId !== undefined || value.trackEpoch !== undefined) throw new AssignmentError("finalize shared identity is invalid");
}

function validateQuality(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AssignmentError("finalize quality is invalid");
  const quality = value as NonNullable<NormalizedTranscriptDocument["quality"]>;
  if (!Number.isInteger(quality.segmentCount) || quality.segmentCount < 0 || !Number.isInteger(quality.wordCount) || quality.wordCount < 0) throw new AssignmentError("finalize quality counts are invalid");
  if (quality.meanConfidence !== undefined && (typeof quality.meanConfidence !== "number" || quality.meanConfidence < 0 || quality.meanConfidence > 1)) throw new AssignmentError("finalize quality confidence is invalid");
}

function boundedText(value: unknown, label: string, max = 512): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new AssignmentError(`${label} is invalid`);
}

function boundedSum(left: number, right: number, label: string): number {
  if (!Number.isSafeInteger(right) || right < 0 || !Number.isSafeInteger(left) || left > Number.MAX_SAFE_INTEGER - right) throw new AssignmentError(`${label} is invalid`);
  return left + right;
}

function compareCues(left: NormalizedCue & { readonly chunkId: string }, right: NormalizedCue & { readonly chunkId: string }): number {
  return (
    left.startMs - right.startMs || left.endMs - right.endMs || identityKey(left.identity).localeCompare(identityKey(right.identity)) || left.trackClass.localeCompare(right.trackClass) || left.text.localeCompare(right.text) || left.chunkId.localeCompare(right.chunkId) || left.attempt - right.attempt
  );
}

function identityKey(value: ManifestIdentity): string {
  return `${value.kind}\u0000${value.participantId ?? ""}\u0000${value.trackEpoch ?? ""}`;
}
