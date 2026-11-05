import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { providerFailureKind, safeErrorCode } from "../src/errors.js";
import { MaiTranscribeProvider } from "../src/mai-provider.js";
import { normalizeTranscriptChunk } from "../src/normalize.js";
import { prepareSpeechAudio } from "../src/speech-audio.js";
import type { ProviderPolicy } from "../src/types.js";

const policy: ProviderPolicy = { timeoutMs: 1000, maxAudioBytes: 100000, maxAudioSeconds: 900, maxResponseBytes: 10000, maxTextChars: 10000, maxSegments: 100, maxWords: 1000, maxRetries: 0, retryBaseDelayMs: 1, retryMaxDelayMs: 1, circuitFailureThreshold: 5, circuitCooldownMs: 1000 };
const audio = readFileSync(new URL("./fixtures/mai-speech.flac", import.meta.url));
const request = { audio, contentType: "audio/flac", chunkId: "test", transcriptLanguage: { mode: "auto" as const } };
const answer = {
  text: "मेरा meeting next",
  language: "hi",
  duration: 2.3,
  usage: { cost: 0.0001 },
  segments: [
    { start: 0, end: 1, text: "मेरा meeting" },
    { start: 1.3, end: 2.2, text: "next" },
  ],
  words: [
    { start: 0, end: 0.4, word: "मेरा" },
    { start: 0.5, end: 1, word: "meeting" },
    { start: 1.3, end: 2.2, word: "next" },
  ],
};
const conversion = { usage: { cost: 0.00001 }, choices: [{ message: { content: '{"tokens":["میرا"]}' } }] };

function provider(fetch: typeof globalThis.fetch, overrides: Partial<ProviderPolicy> = {}) {
  return new MaiTranscribeProvider({ fetch, token: "test-token", policy: { ...policy, ...overrides } });
}

describe("MAI Auto transcription", () => {
  it("trims long silence, restores word/segment source times, and converts Urdu without altering English", async () => {
    const bodies: unknown[] = [];
    const result = await provider(async (url, init) => {
      const body: unknown = JSON.parse(String(init?.body));
      bodies.push(body);
      return Response.json(String(url).endsWith("transcriptions") ? answer : conversion);
    }).transcribe(request);
    expect(bodies[0]).toMatchObject({ model: "microsoft/mai-transcribe-2", response_format: "verbose_json", timestamp_granularities: ["segment", "word"], provider: { zdr: true, data_collection: "deny" } });
    expect(bodies[0]).not.toHaveProperty("language");
    expect(bodies[1]).toMatchObject({ provider: { zdr: true, data_collection: "deny" } });
    expect(JSON.stringify(bodies[1])).not.toContain("meeting next");
    expect(result.text).toBe("میرا meeting next");
    expect(result.language).toBe("ur");
    expect(result.words?.map((word) => word.word)).toEqual(["میرا", "meeting", "next"]);
    expect(result.words?.[2]?.startSeconds).toBeCloseTo(4);
    expect(result.words?.[2]?.endSeconds).toBeCloseTo(4.9);
    expect(result.segments[1]?.startSeconds).toBeCloseTo(4);
    expect(result.durationMs).toBe(2300);
    expect(result.providerReportedCostUsd).toBeCloseTo(0.00011);
  });

  it("preserves complete segment text when the provider returns only partial word timings", async () => {
    const result = await provider(async (url) => Response.json(String(url).endsWith("transcriptions") ? { ...answer, words: answer.words.slice(0, 1) } : conversion)).transcribe(request);
    const identity = { kind: "participant" as const, participantRef: "speaker", participantGeneration: 1, trackId: "track", trackEpoch: "1" };
    const document = normalizeTranscriptChunk({
      jobId: "job",
      episodeId: "episode",
      episodeStartMs: 0,
      episodeEndMs: 5000,
      sourceStartMs: 0,
      sourceEndMs: 5000,
      attempt: 1,
      measuredAudioMs: 5000,
      sourceIdentity: identity,
      sourceTrackClass: "microphone",
      provider: result,
      manifest: {
        schemaVersion: "recording-transcription-source.v1",
        tenantId: "tenant",
        recordingId: "recording",
        episodeId: "episode",
        captureEpoch: 1,
        durationMs: 5000,
        timebase: "recording_relative_ms",
        presentationSha256: "a".repeat(64),
        turns: [{ identity, startMs: 0, endMs: 5000, trackClass: "microphone", displayNameSnapshot: "Speaker", overlap: false }],
      },
    });
    expect(document.cues.map((cue) => cue.text)).toEqual(["میرا meeting", "next"]);
  });

  it("maps exact packed splice timestamps on the integer sample grid", async () => {
    const prepared = await prepareSpeechAudio(readFileSync(new URL("./fixtures/mai-splice.flac", import.meta.url)), 900);
    expect(prepared.batches[0]?.sourceSeconds(2.01, "start")).toBe(3.85);
    expect(prepared.batches[0]?.sourceSeconds(2.01, "end")).toBe(2.01);
  });

  it("never uploads an all-silent chunk and reports an empty successful transcript", async () => {
    const result = await provider(async () => {
      throw new Error("silent audio must not be uploaded");
    }).transcribe({ ...request, audio: readFileSync(new URL("./fixtures/mai-silence.flac", import.meta.url)) });
    expect(result).toMatchObject({ text: "", segments: [], words: [], durationMs: 0, providerReportedCostUsd: 0 });
  });

  it("keeps English and existing Urdu unchanged without a conversion request", async () => {
    let calls = 0;
    const result = await provider(async () => {
      calls++;
      return Response.json({ ...answer, text: "meeting", language: "en", segments: [{ start: 0, end: 1, text: "meeting" }], words: [{ start: 0, end: 1, word: "meeting" }] });
    }).transcribe(request);
    expect(result.text).toBe("meeting");
    expect(calls).toBe(1);
  });

  it.each([new Uint8Array(), new Uint8Array([1, 2])])("rejects empty/malformed audio before contacting the provider", async (invalid) => {
    await expect(
      provider(async () => {
        throw new Error("unexpected upload");
      }).transcribe({ ...request, audio: invalid }),
    ).rejects.toMatchObject({ kind: "schema" });
  });

  it("rejects a decompression size exceeding the renderer bound before allocation", async () => {
    await expect(prepareSpeechAudio(audio, 1)).rejects.toMatchObject({ kind: "schema" });
  });

  it.each([
    [429, "retryable"],
    [503, "retryable"],
    [401, "nonretryable"],
  ])("classifies HTTP %s without retaining a private response body", async (status, kind) => {
    await expect(provider(async () => new Response("PRIVATE_ERROR", { status: Number(status) })).transcribe(request)).rejects.toMatchObject({ kind, status });
  });

  it("aborts a stalled provider request within the configured deadline", async () => {
    await expect(
      provider(
        async (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
          }),
        { timeoutMs: 20 },
      ).transcribe(request),
    ).rejects.toMatchObject({ kind: "timeout" });
  });

  it("keeps a response-body timeout retryable after headers arrive", async () => {
    const pending = provider(
      async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason), { once: true });
            },
          }),
        ),
      { timeoutMs: 20 },
    ).transcribe(request);
    const error: unknown = await pending.catch((failure: unknown) => failure);
    expect(providerFailureKind(error)).toBe("timeout");
    expect(safeErrorCode(error)).toBe("timeout");
  });

  it("rejects speech without requested timestamps instead of inventing timings", async () => {
    await expect(provider(async () => Response.json({ ...answer, words: [] })).transcribe(request)).rejects.toMatchObject({ kind: "schema" });
  });

  it.each(['{"tokens":[]}', '{"tokens":["मेरा"]}', '{"tokens":["my"]}'])("rejects incomplete or wrong-script conversion: %s", async (content) => {
    await expect(provider(async (url) => Response.json(String(url).endsWith("transcriptions") ? answer : { ...conversion, choices: [{ message: { content } }] })).transcribe(request)).rejects.toMatchObject({ kind: "schema" });
  });
});
