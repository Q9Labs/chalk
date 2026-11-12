import { describe, expect, it } from "vitest";
import type { ManifestIdentity, SpeakerTurnManifest } from "../src/assignment-types.js";
import { normalizeTranscriptChunk, type NormalizeInput } from "../src/normalize.js";
import type { ProviderResult } from "../src/provider-types.js";

const identity: ManifestIdentity = { kind: "participant", participantRef: "p1", participantGeneration: 1, trackId: "t1", trackEpoch: "e1" };
const other: ManifestIdentity = { ...identity, participantRef: "p2", trackId: "t2" };

const manifest: SpeakerTurnManifest = {
  schemaVersion: "recording-transcription-source.v1",
  tenantId: "tenant",
  recordingId: "recording",
  episodeId: "episode",
  captureEpoch: 1,
  durationMs: 10_000,
  timebase: "recording_relative_ms",
  presentationSha256: "a".repeat(64),
  turns: [
    { startMs: 1_000, endMs: 3_000, identity, trackClass: "microphone", displayNameSnapshot: "Ada", overlap: false },
    { startMs: 2_000, endMs: 4_000, identity: other, trackClass: "microphone", displayNameSnapshot: "Bo", overlap: false },
  ],
};

function provider(overrides: Partial<ProviderResult> = {}): ProviderResult {
  return { text: "hello world", segments: [{ startSeconds: 0, endSeconds: 2, text: "hello world", confidence: 0.9 }], provider: "deepinfra", model: "m", versionContract: "v", durationMs: 2_000, providerReportedCostUsd: 0.1, ...overrides };
}

function input(overrides: Partial<NormalizeInput> = {}): NormalizeInput {
  return {
    jobId: "job",
    episodeId: "episode",
    episodeStartMs: 1_000,
    episodeEndMs: 3_000,
    sourceStartMs: 0,
    sourceEndMs: 2_000,
    manifest,
    provider: provider(),
    attempt: 2,
    measuredAudioMs: 2_000,
    sourceIdentity: identity,
    sourceTrackClass: "microphone",
    ...overrides,
  };
}

describe("normalizeTranscriptChunk", () => {
  it("places a segment on the recording timeline, attributes it to the chunk speaker and flags the overlap", () => {
    const document = normalizeTranscriptChunk(input());
    expect(document.cues).toEqual([
      { startMs: 1_000, endMs: 3_000, identity, trackClass: "microphone", displayNameSnapshot: "Ada", text: "hello world", overlap: true, provider: "deepinfra", model: "m", versionContract: "v", attempt: 2, quality: { confidence: 0.9 } },
    ]);
    expect(document).toMatchObject({ schemaVersion: "transcript.v1", transcriptLanguage: { mode: "auto" }, jobId: "job", attempt: 2, measuredAudioMs: 2_000, providerObservedDurationMs: 2_000, providerReportedCostUsd: 0.1 });
  });

  it("builds the cue text from word timings when the segment has them", () => {
    const words = [
      { startSeconds: 0, endSeconds: 0.5, word: "hello" },
      { startSeconds: 0.6, endSeconds: 1.5, word: "there" },
    ];
    const document = normalizeTranscriptChunk(input({ provider: provider({ words }) }));
    expect(document.cues.map((cue) => [cue.text, cue.startMs, cue.endMs])).toEqual([["hello there", 1_000, 2_500]]);
  });

  it("keeps the segment text when the provider marks it as authoritative", () => {
    const segments = [{ startSeconds: 0, endSeconds: 1, text: "kept", useSegmentText: true as const }];
    const words = [{ startSeconds: 0, endSeconds: 1, word: "dropped" }];
    expect(normalizeTranscriptChunk(input({ provider: provider({ segments, words }) })).cues[0]?.text).toBe("kept");
  });

  it("drops a segment that falls outside the chunk and fails when no turn of the chunk speaker covers a segment", () => {
    const late = provider({ segments: [{ startSeconds: 5, endSeconds: 6, text: "late" }] });
    expect(normalizeTranscriptChunk(input({ provider: late })).cues).toEqual([]);
    expect(() => normalizeTranscriptChunk(input({ sourceIdentity: { ...identity, participantRef: "nobody" } }))).toThrow("segment has no authenticated source turn");
  });

  it.each([
    ["an empty episode range", { episodeEndMs: 1_000 }, "chunk episode range is invalid"],
    ["a source range of a different length", { sourceEndMs: 1_500 }, "chunk source range is invalid"],
    ["a fractional measured duration", { measuredAudioMs: 1.5 }, "measured duration is invalid"],
  ])("rejects %s", (_name, overrides, message) => {
    expect(() => normalizeTranscriptChunk(input(overrides))).toThrow(message);
  });
});
