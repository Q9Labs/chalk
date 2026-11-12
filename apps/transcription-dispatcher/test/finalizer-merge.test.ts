import { describe, expect, it } from "vitest";
import { mergeTranscriptDocuments, type ChunkDocument } from "../src/finalizer-merge.js";
import type { NormalizedCue, NormalizedTranscriptDocument } from "../src/types.js";

function cue(overrides: Partial<NormalizedCue> = {}): NormalizedCue {
  return {
    startMs: 0,
    endMs: 100,
    identity: { kind: "participant", participantRef: "p1", participantGeneration: 1, trackId: "t1", trackEpoch: "e1" },
    trackClass: "microphone",
    displayNameSnapshot: "Ada",
    text: "hello",
    overlap: false,
    provider: "deepinfra",
    model: "m1",
    versionContract: "v1",
    attempt: 1,
    ...overrides,
  };
}

function chunk(id: string, startMs: number, endMs: number, cues: NormalizedCue[], overrides: Partial<NormalizedTranscriptDocument> = {}): ChunkDocument {
  return {
    assignment: {
      chunkId: id,
      inputUrl: "https://objects.example.test/chunk",
      inputUrlExpiresAt: "2030-01-01T00:00:00Z",
      inputContentType: "application/json",
      inputSizeBytes: 1,
      inputSha256: "a".repeat(64),
      episodeStartMs: startMs,
      episodeEndMs: endMs,
    },
    document: {
      schemaVersion: "transcript.v1",
      jobId: `job-${id}`,
      episodeId: "episode-1",
      cues,
      language: "en",
      provider: "deepinfra",
      model: "m1",
      versionContract: "v1",
      attempt: 1,
      measuredAudioMs: endMs - startMs,
      providerReportedCostUsd: 0.5,
      providerObservedDurationMs: endMs - startMs,
      quality: { segmentCount: cues.length, wordCount: cues.length * 2, meanConfidence: 0.8 },
      ...overrides,
    },
  };
}

function merge(chunks: ChunkDocument[]): NormalizedTranscriptDocument {
  return mergeTranscriptDocuments({ jobId: "job-final", episodeId: "episode-1", attempt: 3, chunks });
}

describe("mergeTranscriptDocuments", () => {
  it("orders chunks and cues, sums measurements, and keeps a single provider summary", () => {
    const merged = merge([chunk("b", 1_000, 2_000, [cue({ startMs: 1_000, endMs: 1_100, text: "two" })]), chunk("a", 0, 1_000, [cue({ startMs: 0, endMs: 100, text: "one" })])]);
    expect(merged.cues.map((entry) => entry.text)).toEqual(["one", "two"]);
    expect(merged).toMatchObject({
      schemaVersion: "transcript.v1",
      jobId: "job-final",
      episodeId: "episode-1",
      attempt: 3,
      provider: "deepinfra",
      model: "m1",
      versionContract: "v1",
      language: "en",
      measuredAudioMs: 2_000,
      providerObservedDurationMs: 2_000,
      providerReportedCostUsd: 1,
      quality: { segmentCount: 2, wordCount: 4, meanConfidence: 0.8 },
    });
  });

  it("reports mixed metadata, drops a language that differs, and drops cost when a chunk has none", () => {
    const merged = merge([
      chunk("a", 0, 1_000, [cue({ provider: "deepinfra", model: "m1" })], { language: "en" }),
      chunk("b", 1_000, 2_000, [cue({ startMs: 1_000, endMs: 1_100, provider: "cloudflare", model: "m2" })], { provider: "cloudflare", model: "m2", language: "fr", providerReportedCostUsd: undefined }),
    ]);
    expect(merged.provider).toBe("mixed");
    expect(merged.model).toBe("mixed");
    expect(merged.versionContract).toBe("v1");
    expect(merged).not.toHaveProperty("language");
    expect(merged).not.toHaveProperty("providerReportedCostUsd");
  });

  it("weights mean confidence by segment count", () => {
    const merged = merge([
      chunk("a", 0, 1_000, [cue()], { quality: { segmentCount: 3, wordCount: 1, meanConfidence: 1 } }),
      chunk("b", 1_000, 2_000, [cue({ startMs: 1_000, endMs: 1_100 })], { quality: { segmentCount: 1, wordCount: 1, meanConfidence: 0 } }),
    ]);
    expect(merged.quality).toEqual({ segmentCount: 4, wordCount: 2, meanConfidence: 0.75 });
  });

  it("drops blank cues instead of failing", () => {
    const merged = merge([chunk("a", 0, 1_000, [cue({ text: "  " }), cue({ startMs: 200, endMs: 300, text: "kept" })])]);
    expect(merged.cues.map((entry) => entry.text)).toEqual(["kept"]);
  });

  it("keeps overlapping cues from different chunks and marks both", () => {
    const merged = merge([chunk("a", 0, 1_000, [cue({ startMs: 0, endMs: 500 })]), chunk("b", 0, 1_000, [cue({ startMs: 200, endMs: 700, text: "other" })])]);
    expect(merged.cues.map((entry) => entry.overlap)).toEqual([true, true]);
  });

  it("does not mark cues in the same chunk or cues that only touch", () => {
    const merged = merge([chunk("a", 0, 1_000, [cue({ startMs: 0, endMs: 500 }), cue({ startMs: 100, endMs: 600, text: "same chunk" })]), chunk("b", 0, 1_000, [cue({ startMs: 700, endMs: 800, text: "later" })])]);
    expect(merged.cues.every((entry) => entry.overlap === false)).toBe(true);
    const touching = merge([chunk("a", 0, 1_000, [cue({ startMs: 0, endMs: 500 })]), chunk("b", 0, 1_000, [cue({ startMs: 500, endMs: 800, text: "touch" })])]);
    expect(touching.cues.every((entry) => entry.overlap === false)).toBe(true);
  });

  it("marks overlap exactly like a brute-force check over random cue sets", () => {
    let seed = 20_261_113;
    const next = (limit: number): number => {
      seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return seed % limit;
    };
    for (let round = 0; round < 200; round += 1) {
      const chunkCount = 1 + next(4);
      const chunks: ChunkDocument[] = [];
      const all: Array<{ chunkId: string; startMs: number; endMs: number; text: string }> = [];
      for (let index = 0; index < chunkCount; index += 1) {
        const id = `c${index}`;
        const cues: NormalizedCue[] = [];
        for (let count = next(6); count > 0; count -= 1) {
          const startMs = next(900);
          const endMs = startMs + 1 + next(150);
          const text = `${id}-${cues.length}`;
          cues.push(cue({ startMs, endMs, text }));
          all.push({ chunkId: id, startMs, endMs, text });
        }
        chunks.push(chunk(id, 0, 1_000, cues));
      }
      if (all.length === 0) continue;
      const merged = merge(chunks);
      expect(merged.cues).toHaveLength(all.length);
      for (const entry of merged.cues) {
        const source = all.find((candidate) => candidate.text === entry.text);
        const expected = all.some((other) => other.chunkId !== source?.chunkId && other.startMs < entry.endMs && other.endMs > entry.startMs);
        expect(entry.overlap, `${round}:${entry.text}`).toBe(expected);
      }
    }
  });

  it.each([
    ["no chunks", () => [], "finalize chunk count is invalid"],
    ["duplicate chunk IDs", () => [chunk("a", 0, 1_000, [cue()]), chunk("a", 0, 1_000, [cue()])], "finalize chunk IDs are duplicated"],
    ["schema drift", () => [chunk("a", 0, 1_000, [cue()], { schemaVersion: "transcript.v2" as "transcript.v1" })], "finalize schema drift"],
    ["another episode", () => [chunk("a", 0, 1_000, [cue()], { episodeId: "episode-2" })], "finalize identity metadata conflicts"],
    ["a mixed chunk provider", () => [chunk("a", 0, 1_000, [cue()], { provider: "mixed" })], "finalize provider is invalid"],
    ["a billing claim", () => [chunk("a", 0, 1_000, [cue()], { billedAudioSeconds: 4 })], "finalize billing claim is not authoritative"],
    ["measured audio longer than the chunk", () => [chunk("a", 0, 1_000, [cue()], { measuredAudioMs: 1_001 })], "finalize measured duration is invalid"],
    ["a negative reported cost", () => [chunk("a", 0, 1_000, [cue()], { providerReportedCostUsd: -1 })], "finalize reported cost is invalid"],
    ["a cue outside the chunk", () => [chunk("a", 0, 1_000, [cue({ startMs: 900, endMs: 1_100 })])], "finalize cue bounds are invalid"],
    ["an empty-length cue", () => [chunk("a", 0, 1_000, [cue({ startMs: 10, endMs: 10 })])], "finalize cue bounds are invalid"],
    ["a non-microphone track", () => [chunk("a", 0, 1_000, [cue({ trackClass: "screen" as "microphone" })])], "finalize cue track class is invalid"],
    ["an incomplete identity", () => [chunk("a", 0, 1_000, [cue({ identity: { kind: "participant", participantRef: "", participantGeneration: 1, trackId: "t", trackEpoch: "e" } })])], "finalize participant identity is incomplete"],
    ["a cue that disagrees with its document", () => [chunk("a", 0, 1_000, [cue({ model: "other" })])], "finalize cue metadata conflicts"],
    ["a cue confidence above 1", () => [chunk("a", 0, 1_000, [cue({ quality: { confidence: 2 } })])], "finalize cue confidence is invalid"],
    ["negative quality counts", () => [chunk("a", 0, 1_000, [cue()], { quality: { segmentCount: -1, wordCount: 0 } })], "finalize quality counts are invalid"],
    ["different language modes", () => [chunk("a", 0, 1_000, [cue()], { transcriptLanguage: { mode: "auto" } }), chunk("b", 1_000, 2_000, [cue({ startMs: 1_000, endMs: 1_100 })], { transcriptLanguage: { mode: "fixed", language: "en" } })], "finalize transcript language modes differ"],
  ])("rejects %s", (_name, build, message) => {
    expect(() => merge(build())).toThrow(message);
  });
});
