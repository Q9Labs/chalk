import { AssignmentError } from "./errors.js";
import type { ManifestIdentity, NormalizedCue, NormalizedTranscriptDocument, ProviderResult, SpeakerTurn, SpeakerTurnManifest, TrackClass } from "./types.js";

type CueTurn = Pick<SpeakerTurn, "identity" | "trackClass"> & Partial<Pick<SpeakerTurn, "displayNameSnapshot" | "overlap">>;

export function normalizeTranscriptChunk(input: {
  jobId: string;
  sessionId: string;
  meetingStartMs: number;
  meetingEndMs: number;
  manifest: SpeakerTurnManifest;
  provider: ProviderResult;
  attempt: number;
  measuredAudioMs: number;
  sourceIdentity?: ManifestIdentity;
  sourceTrackClass?: TrackClass;
}): NormalizedTranscriptDocument {
  if (!Number.isInteger(input.meetingStartMs) || !Number.isInteger(input.meetingEndMs) || input.meetingEndMs <= input.meetingStartMs) throw new AssignmentError("chunk meeting range is invalid");
  if (!Number.isInteger(input.measuredAudioMs) || input.measuredAudioMs < 0) throw new AssignmentError("measured duration is invalid");
  const cues = input.provider.segments.flatMap((segment) => {
    const startMs = Math.max(input.meetingStartMs, input.meetingStartMs + Math.round(segment.startSeconds * 1_000));
    const endMs = Math.min(input.meetingEndMs, input.meetingStartMs + Math.round(segment.endSeconds * 1_000));
    if (endMs <= startMs) return [];
    const allMatches = input.manifest.turns.filter((turn) => turn.endMs > startMs && turn.startMs < endMs);
    const authoritative = allMatches.filter((turn) => isAuthoritativeTurn(turn, input.sourceIdentity, input.sourceTrackClass));
    if (input.provider.words && input.provider.words.length > 0) {
      return cuesFromWords(segment, startMs, endMs, authoritative, allMatches, input);
    }
    return cuesFromSegment(segment, startMs, endMs, authoritative, allMatches, input);
  });
  return {
    schemaVersion: "transcript.v1",
    jobId: input.jobId,
    sessionId: input.sessionId,
    cues,
    ...(input.provider.language === undefined ? {} : { language: input.provider.language }),
    provider: input.provider.provider,
    model: input.provider.model,
    versionContract: input.provider.versionContract,
    attempt: input.attempt,
    measuredAudioMs: input.measuredAudioMs,
    ...(input.provider.durationMs === undefined ? {} : { providerObservedDurationMs: input.provider.durationMs }),
    ...(input.provider.quality === undefined ? {} : { quality: input.provider.quality }),
  };
}

function cuesFromWords(segment: ProviderResult["segments"][number], segmentStartMs: number, segmentEndMs: number, authoritative: SpeakerTurn[], allMatches: SpeakerTurn[], input: Parameters<typeof normalizeTranscriptChunk>[0]): NormalizedCue[] {
  const words = input.provider.words?.filter((word) => word.endSeconds > segment.startSeconds && word.startSeconds < segment.endSeconds) ?? [];
  const groups: Array<{ turn: SpeakerTurn | undefined; words: typeof words }> = [];
  for (const word of words) {
    const wordStartMs = input.meetingStartMs + Math.round(word.startSeconds * 1_000);
    const wordEndMs = input.meetingStartMs + Math.round(word.endSeconds * 1_000);
    const matches = authoritative.filter((turn) => turn.endMs > wordStartMs && turn.startMs < wordEndMs);
    if (matches.length > 1) throw new AssignmentError("word crosses multiple source track epochs");
    const turn = matches[0];
    const previous = groups.at(-1);
    if (previous && identityEquals(previous.turn?.identity, turn?.identity) && previous.turn?.trackClass === turn?.trackClass) previous.words.push(word);
    else groups.push({ turn, words: [word] });
  }
  if (groups.length === 0) return cuesFromSegment(segment, segmentStartMs, segmentEndMs, authoritative, allMatches, input);
  return groups.map((group) => {
    const first = group.words[0];
    const last = group.words.at(-1);
    if (!first || !last) throw new AssignmentError("provider word timings are invalid");
    const startMs = Math.max(segmentStartMs, input.meetingStartMs + Math.round(first.startSeconds * 1_000));
    const endMs = Math.min(segmentEndMs, input.meetingStartMs + Math.round(last.endSeconds * 1_000));
    if (endMs <= startMs) throw new AssignmentError("provider word timing is invalid");
    if (!group.turn && input.sourceIdentity && input.sourceIdentity.kind !== "unknown") throw new AssignmentError("word has no unambiguous source turn");
    const cueTurn = group.turn;
    const authoritativeTurn = group.turn;
    const overlap = Boolean(authoritativeTurn && (authoritativeTurn.overlap || allMatches.some((other) => other !== authoritativeTurn && overlaps(other, authoritativeTurn))));
    return cueForSegment(group.words.map((word) => word.word).join(" "), startMs, endMs, cueTurn, overlap, first.confidence, input);
  });
}

function cuesFromSegment(segment: ProviderResult["segments"][number], segmentStartMs: number, segmentEndMs: number, authoritative: SpeakerTurn[], allMatches: SpeakerTurn[], input: Parameters<typeof normalizeTranscriptChunk>[0]): NormalizedCue[] {
  if (authoritative.length > 1) throw new AssignmentError("segment crosses multiple source track epochs");
  const turn = authoritative[0];
  if (!turn) {
    if (input.sourceIdentity && input.sourceIdentity.kind !== "unknown") throw new AssignmentError("segment has no unambiguous source turn");
    return [cueForSegment(segment.text, segmentStartMs, segmentEndMs, undefined, false, segment.confidence, input)];
  }
  const overlap = turn.overlap || allMatches.some((other) => other !== turn && overlaps(other, turn));
  return [cueForSegment(segment.text, Math.max(segmentStartMs, turn.startMs), Math.min(segmentEndMs, turn.endMs), turn, overlap, segment.confidence, input)];
}

function isAuthoritativeTurn(turn: SpeakerTurn, identity: ManifestIdentity | undefined, trackClass: TrackClass | undefined): boolean {
  return identity !== undefined ? identityEquals(turn.identity, identity) && turn.trackClass === trackClass : true;
}

function identityEquals(left: ManifestIdentity | undefined, right: ManifestIdentity | undefined): boolean {
  return left?.kind === right?.kind && left?.participantId === right?.participantId && left?.trackEpoch === right?.trackEpoch;
}

function overlaps(left: SpeakerTurn, right: SpeakerTurn): boolean {
  return left.endMs > right.startMs && left.startMs < right.endMs;
}

function cueForSegment(text: string, startMs: number, endMs: number, turn: CueTurn | undefined, overlap: boolean, confidence: number | undefined, input: Parameters<typeof normalizeTranscriptChunk>[0]): NormalizedCue {
  return {
    startMs,
    endMs,
    identity: turn?.identity ?? { kind: "unknown" },
    trackClass: turn?.trackClass ?? "unknown",
    ...(turn?.displayNameSnapshot === undefined ? {} : { displayNameSnapshot: turn.displayNameSnapshot }),
    text,
    overlap,
    provider: input.provider.provider,
    model: input.provider.model,
    versionContract: input.provider.versionContract,
    attempt: input.attempt,
    ...(confidence === undefined ? {} : { quality: { confidence } }),
  };
}

export function serializeTranscript(document: NormalizedTranscriptDocument): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(document));
}
