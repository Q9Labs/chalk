import { describe, expect, it } from "vitest";
import { mergeTranscriptDocuments, type ChunkDocument } from "../src/finalizer-merge.js";

function chunk(index: number, cost?: number): ChunkDocument {
  return {
    assignment: { chunkId: `chunk-${index}`, inputUrl: "https://objects.example.test/chunk", inputUrlExpiresAt: "2030-01-01T00:00:00Z", inputContentType: "application/json", inputSizeBytes: 100, inputSha256: "a".repeat(64), episodeStartMs: 0, episodeEndMs: 1000 },
    document: {
      schemaVersion: "transcript.v1",
      jobId: `job-${index}`,
      episodeId: "episode-1",
      cues: [],
      provider: "deepinfra",
      model: "openai/whisper-large-v3-turbo",
      versionContract: "deepinfra-native-whisper-turbo.v1",
      attempt: 1,
      measuredAudioMs: 1000,
      ...(cost === undefined ? {} : { providerReportedCostUsd: cost }),
    },
  };
}

describe("reported provider charges", () => {
  it("sums observed successful-request charges only when every chunk reports a charge", () => {
    const result = mergeTranscriptDocuments({ jobId: "finalize-1", episodeId: "episode-1", attempt: 1, chunks: [chunk(1, 0.00001), chunk(2, 0.00002)] });
    expect(result.providerReportedCostUsd).toBeCloseTo(0.00003, 8);
    expect(result.billedAudioSeconds).toBeUndefined();
    const partial = mergeTranscriptDocuments({ jobId: "finalize-1", episodeId: "episode-1", attempt: 1, chunks: [chunk(1, 0.00001), chunk(2)] });
    expect(partial.providerReportedCostUsd).toBeUndefined();
  });

  it("rejects invalid reported charges before publishing a final transcript", () => {
    for (const cost of [-1, Number.POSITIVE_INFINITY, Number.NaN, 1001]) {
      expect(() => mergeTranscriptDocuments({ jobId: "finalize-1", episodeId: "episode-1", attempt: 1, chunks: [chunk(1, cost)] })).toThrow(/reported cost/);
    }
  });
});
