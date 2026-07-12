import { describe, expect, it } from "vitest";
import { InvocationCircuit, transcribeWithFallback } from "../src/retry.js";
import { normalizeTranscriptChunk } from "../src/normalize.js";
import { ProviderError } from "../src/errors.js";
import type { ProviderPolicy, ProviderResult, TranscriptionProvider } from "../src/types.js";

const policy: ProviderPolicy = {
  timeoutMs: 100,
  maxAudioBytes: 10_000,
  maxAudioSeconds: 60,
  maxResponseBytes: 10_000,
  maxTextChars: 1_000,
  maxSegments: 10,
  maxWords: 20,
  maxRetries: 1,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 2,
  circuitFailureThreshold: 1,
  circuitCooldownMs: 1_000,
};

const result: ProviderResult = {
  text: "hello",
  segments: [{ startSeconds: 0, endSeconds: 1, text: "hello", confidence: 0.9 }],
  provider: "cloudflare",
  model: "@cf/openai/whisper-large-v3-turbo",
  versionContract: "cf-1",
};

describe("normalization and fallback", () => {
  it("maps one source epoch once and marks overlap without borrowing another track", () => {
    const document = normalizeTranscriptChunk({
      jobId: "job",
      sessionId: "session",
      meetingStartMs: 0,
      meetingEndMs: 2_000,
      manifest: {
        schemaVersion: "manifest.v1",
        turns: [
          { startMs: 0, endMs: 1_000, identity: { kind: "participant", participantId: "p", trackEpoch: "epoch-1" }, trackClass: "microphone", displayNameSnapshot: "Local", overlap: false },
          { startMs: 200, endMs: 400, identity: { kind: "shared" }, trackClass: "system-audio", overlap: true },
        ],
      },
      provider: { ...result, segments: [{ startSeconds: 0.1, endSeconds: 0.4, text: "one" }] },
      attempt: 2,
      measuredAudioMs: 2_000,
      sourceIdentity: { kind: "participant", participantId: "p", trackEpoch: "epoch-1" },
      sourceTrackClass: "microphone",
    });
    expect(document.cues.map((cue) => cue.identity)).toEqual([{ kind: "participant", participantId: "p", trackEpoch: "epoch-1" }]);
    expect(document.cues[0]?.overlap).toBe(true);
    const reconnect = normalizeTranscriptChunk({
      jobId: "job",
      sessionId: "session",
      meetingStartMs: 1_000,
      meetingEndMs: 2_000,
      manifest: { schemaVersion: "manifest.v1", turns: [{ startMs: 1_000, endMs: 2_000, identity: { kind: "participant", participantId: "p", trackEpoch: "epoch-2" }, trackClass: "microphone", displayNameSnapshot: "Local", overlap: false }] },
      provider: { ...result, segments: [{ startSeconds: 0, endSeconds: 1, text: "reconnected" }] },
      attempt: 2,
      measuredAudioMs: 1_000,
      sourceIdentity: { kind: "participant", participantId: "p", trackEpoch: "epoch-2" },
      sourceTrackClass: "microphone",
    });
    expect(reconnect.cues[0]?.identity.trackEpoch).toBe("epoch-2");
  });

  it("preserves every provider word once across a cue", () => {
    const document = normalizeTranscriptChunk({
      jobId: "job",
      sessionId: "session",
      meetingStartMs: 0,
      meetingEndMs: 1_000,
      manifest: { schemaVersion: "manifest.v1", turns: [{ startMs: 0, endMs: 1_000, identity: { kind: "participant", participantId: "p", trackEpoch: "epoch-1" }, trackClass: "microphone", overlap: false }] },
      provider: {
        ...result,
        text: "one two",
        segments: [{ startSeconds: 0, endSeconds: 1, text: "one two" }],
        words: [
          { startSeconds: 0, endSeconds: 0.4, word: "one" },
          { startSeconds: 0.5, endSeconds: 0.9, word: "two" },
        ],
      },
      attempt: 1,
      measuredAudioMs: 1_000,
      sourceIdentity: { kind: "participant", participantId: "p", trackEpoch: "epoch-1" },
      sourceTrackClass: "microphone",
    });
    expect(document.cues).toHaveLength(1);
    expect(document.cues[0]?.text).toBe("one two");
  });

  it("preserves segments with mixed provider word coverage", () => {
    const document = normalizeTranscriptChunk({
      jobId: "job",
      sessionId: "session",
      meetingStartMs: 0,
      meetingEndMs: 1_000,
      manifest: { schemaVersion: "manifest.v1", turns: [{ startMs: 0, endMs: 1_000, identity: { kind: "unknown" }, trackClass: "unknown", overlap: false }] },
      provider: {
        ...result,
        text: "first second",
        segments: [
          { startSeconds: 0, endSeconds: 0.4, text: "first" },
          { startSeconds: 0.5, endSeconds: 1, text: "second" },
        ],
        words: [{ startSeconds: 0, endSeconds: 0.4, word: "first" }],
      },
      attempt: 1,
      measuredAudioMs: 1_000,
    });
    expect(document.cues.map((cue) => cue.text)).toEqual(["first", "second"]);
    expect(document.cues[1]).toMatchObject({ startMs: 500, endMs: 1_000, text: "second" });
  });

  it("falls back sequentially after bounded primary retry without racing", async () => {
    const calls: string[] = [];
    const primary: TranscriptionProvider = {
      name: "deepinfra",
      transcribe: async () => {
        calls.push("primary");
        throw new ProviderError("busy", "retryable", { status: 429 });
      },
    };
    const fallback: TranscriptionProvider = {
      name: "cloudflare",
      transcribe: async () => {
        calls.push("fallback");
        return result;
      },
    };
    const response = await transcribeWithFallback({ primary, fallback, request: { audio: new Uint8Array([1]), contentType: "audio/mpeg", chunkId: "chunk" }, policy, circuit: new InvocationCircuit(1, 1), runtime: { sleep: async () => undefined, random: () => 0, now: () => 1 } });
    expect(response.usedFallback).toBe(true);
    expect(calls).toEqual(["primary", "fallback"]);
  });
});
