import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { mergeTranscriptDocuments, runFinalizeDispatcher } from "../src/finalizer.js";
import { ControlApiError } from "../src/errors.js";
import type { ControlApi, FinalizeAssignment, NormalizedTranscriptDocument, ReleaseConfig } from "../src/types.js";

const config: ReleaseConfig = {
  environment: "test",
  releaseId: "release-1",
  controlApiAudience: "chalk-control-api",
  controlApiBaseUrl: "https://control.example",
  maxBatch: 10,
  concurrency: 3,
  timeoutReserveMs: 60_000,
  privacyGateAccepted: true,
  deepInfra: { enabled: false, model: "openai/whisper-large-v3-turbo" },
  cloudflare: { token: "secret", accountId: "account", modelSlug: "@cf/openai/whisper-large-v3-turbo", adapterContractVersion: "cf-1", corpusDigest: "a".repeat(64) },
  provider: { timeoutMs: 1_000, maxAudioBytes: 10_000, maxAudioSeconds: 60, maxResponseBytes: 10_000, maxTextChars: 1_000, maxSegments: 10, maxWords: 100, maxRetries: 0, retryBaseDelayMs: 1, retryMaxDelayMs: 2, circuitFailureThreshold: 2, circuitCooldownMs: 100 },
};

const expiry = new Date(Date.now() + 300_000).toISOString();

function chunkDocument(overrides: Partial<NormalizedTranscriptDocument> = {}): NormalizedTranscriptDocument {
  return {
    schemaVersion: "transcript.v1",
    jobId: "job",
    sessionId: "session",
    cues: [{ startMs: 0, endMs: 100, identity: { kind: "unknown" }, trackClass: "unknown", text: "hello", overlap: false, provider: "cloudflare", model: "model", versionContract: "cf-1", attempt: 1 }],
    language: "en",
    provider: "cloudflare",
    model: "model",
    versionContract: "cf-1",
    attempt: 1,
    measuredAudioMs: 100,
    ...overrides,
  };
}

function assignment(chunks: Array<{ id: string; start: number; end: number; document: NormalizedTranscriptDocument }>): FinalizeAssignment & { documents: NormalizedTranscriptDocument[] } {
  return {
    jobId: "job",
    transcriptId: "transcript",
    sessionId: "session",
    attempt: 1,
    leaseToken: "lease",
    leaseExpiresAt: expiry,
    chunks: chunks.map(({ id, start, end, document }) => {
      const bytes = new TextEncoder().encode(JSON.stringify(document));
      return {
        chunkId: id,
        inputUrl: `https://r2.example/${id}`,
        inputUrlExpiresAt: expiry,
        inputContentType: "application/json",
        inputSizeBytes: bytes.byteLength,
        inputSha256: createHash("sha256").update(bytes).digest("hex"),
        meetingStartMs: start,
        meetingEndMs: end,
      };
    }),
    outputPutUrl: "https://r2.example/final",
    outputPutUrlExpiresAt: expiry,
    outputContentType: "application/json",
    documents: chunks.map(({ document }) => document),
  };
}

function dependencies(control: ControlApi, current: FinalizeAssignment, documents: NormalizedTranscriptDocument[], fetchOverride?: typeof fetch) {
  const bytesByUrl = new Map(current.chunks.map((chunk, index) => [chunk.inputUrl, new TextEncoder().encode(JSON.stringify(documents[index]))]));
  const fetch =
    fetchOverride ??
    vi.fn(async (url: string, init?: RequestInit) => {
      const bytes = bytesByUrl.get(url);
      if (bytes) return new Response(bytes, { headers: { "content-type": "application/json", "content-length": String(bytes.byteLength) } });
      expect(init?.method).toBe("PUT");
      return new Response(null, { status: 201 });
    });
  return { config, control, fallback: { name: "cloudflare", transcribe: vi.fn() }, fetch };
}

describe("final transcript artifact dispatcher", () => {
  it("sorts cues deterministically, unions languages, and completes once", async () => {
    const first = chunkDocument({ cues: [{ startMs: 500, endMs: 700, identity: { kind: "unknown" }, trackClass: "unknown", text: "second", overlap: false, provider: "cloudflare", model: "model", versionContract: "cf-1", attempt: 1 }], language: "fr" });
    const second = chunkDocument({ cues: [{ startMs: 100, endMs: 300, identity: { kind: "unknown" }, trackClass: "unknown", text: "first", overlap: false, provider: "cloudflare", model: "model", versionContract: "cf-1", attempt: 1 }], language: "en" });
    const current = assignment([
      { id: "b", start: 400, end: 800, document: first },
      { id: "a", start: 0, end: 400, document: second },
    ]);
    const completeFinalize = vi.fn(async () => undefined);
    const heartbeatFinalize = vi.fn(async () => undefined);
    const control: ControlApi = { claim: vi.fn(), heartbeat: vi.fn(), heartbeatFinalize, retry: vi.fn(), complete: vi.fn(), claimFinalize: vi.fn(async () => ({ assignments: [current] })), completeFinalize, retryFinalize: vi.fn() };
    const output = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/final")) {
        expect(init?.method).toBe("PUT");
        const body = JSON.parse(String(init?.body)) as NormalizedTranscriptDocument;
        expect(body.cues.map((cue) => cue.text)).toEqual(["first", "second"]);
        expect(body.language).toBeUndefined();
        return new Response(null, { status: 201 });
      }
      const chunk = current.chunks.find((candidate) => candidate.inputUrl === url);
      const index = current.chunks.indexOf(chunk as (typeof current.chunks)[number]);
      const bytes = new TextEncoder().encode(JSON.stringify(current.documents[index]));
      return new Response(bytes, { headers: { "content-type": "application/json", "content-length": String(bytes.byteLength) } });
    });
    const result = await runFinalizeDispatcher({ source: "finalize", journeyId: "journey" }, { getRemainingTimeInMillis: () => 120_000 }, { ...dependencies(control, current, [first, second], output) });
    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(completeFinalize).toHaveBeenCalledWith(expect.objectContaining({ languages: ["en", "fr"], checksumSha256: expect.any(String) }));
    expect(heartbeatFinalize).toHaveBeenCalledWith(expect.objectContaining({ assignment: current }));
  });

  it("retains overlapping tracks and records mixed provider metadata", async () => {
    const first = chunkDocument({
      jobId: "chunk-job-a",
      cues: [{ startMs: 0, endMs: 120, identity: { kind: "participant", participantId: "p1", trackEpoch: "e1" }, trackClass: "microphone", text: "one", overlap: false, provider: "deepinfra", model: "di-model", versionContract: "di-1", attempt: 1 }],
      provider: "deepinfra",
      model: "di-model",
      versionContract: "di-1",
    });
    const second = chunkDocument({
      jobId: "chunk-job-b",
      cues: [{ startMs: 60, endMs: 180, identity: { kind: "participant", participantId: "p2", trackEpoch: "e2" }, trackClass: "microphone", text: "two", overlap: false, provider: "cloudflare", model: "cf-model", versionContract: "cf-1", attempt: 1 }],
      provider: "cloudflare",
      model: "cf-model",
      versionContract: "cf-1",
    });
    const current = assignment([
      { id: "a", start: 0, end: 200, document: first },
      { id: "b", start: 0, end: 200, document: second },
    ]);
    const completeFinalize = vi.fn(async () => undefined);
    const control: ControlApi = { claim: vi.fn(), heartbeat: vi.fn(), retry: vi.fn(), complete: vi.fn(), claimFinalize: vi.fn(async () => ({ assignments: [current] })), completeFinalize, retryFinalize: vi.fn() };
    const output = vi.fn(async (url: string, init?: RequestInit) => {
      const chunk = current.chunks.find((candidate) => candidate.inputUrl === url);
      if (chunk) {
        const index = current.chunks.indexOf(chunk);
        const bytes = new TextEncoder().encode(JSON.stringify(current.documents[index]));
        return new Response(bytes, { headers: { "content-type": "application/json", "content-length": String(bytes.byteLength) } });
      }
      const body = JSON.parse(String(init?.body)) as NormalizedTranscriptDocument;
      expect(body.provider).toBe("mixed");
      expect(body.model).toBe("mixed");
      expect(body.cues.every((cue) => cue.overlap)).toBe(true);
      return new Response(null, { status: 201 });
    });
    const result = await runFinalizeDispatcher({ source: "finalize" }, { getRemainingTimeInMillis: () => 120_000 }, { ...dependencies(control, current, [first, second], output) });
    expect(result).toMatchObject({ completed: 1, failed: 0 });
    expect(completeFinalize).toHaveBeenCalledWith(expect.objectContaining({ provider: "mixed", model: "mixed", versionContract: "mixed" }));
  });

  it("treats a conditional-put duplicate and a stale completion as safe late work", async () => {
    const document = chunkDocument();
    const current = assignment([{ id: "a", start: 0, end: 200, document }]);
    const retryFinalize = vi.fn(async () => undefined);
    const completeFinalize = vi.fn(async () => {
      throw new ControlApiError("late", 409);
    });
    const control: ControlApi = { claim: vi.fn(), heartbeat: vi.fn(), retry: vi.fn(), complete: vi.fn(), claimFinalize: vi.fn(async () => ({ assignments: [current] })), completeFinalize, retryFinalize };
    const duplicateFetch = vi.fn(async (url: string) => (url.endsWith("/final") ? new Response(null, { status: 412 }) : new Response(new TextEncoder().encode(JSON.stringify(document)), { headers: { "content-type": "application/json" } })));
    const duplicate = await runFinalizeDispatcher({ source: "finalize" }, { getRemainingTimeInMillis: () => 120_000 }, { ...dependencies(control, current, [document], duplicateFetch) });
    expect(duplicate).toMatchObject({ completed: 0, failed: 1 });
    expect(completeFinalize).toHaveBeenCalledWith(expect.objectContaining({ checksumSha256: expect.any(String) }));
    expect(retryFinalize).not.toHaveBeenCalled();

    const late = await runFinalizeDispatcher({ source: "finalize" }, { getRemainingTimeInMillis: () => 120_000 }, { ...dependencies({ ...control, claimFinalize: vi.fn(async () => ({ assignments: [current] })), retryFinalize }, current, [document]) });
    expect(late).toMatchObject({ completed: 0, failed: 1 });
  });

  it("re-completes an existing final artifact after a transient completion failure", async () => {
    const document = chunkDocument();
    const current = assignment([{ id: "a", start: 0, end: 200, document }]);
    const retryFinalize = vi.fn(async () => undefined);
    const completeFinalize = vi
      .fn<ControlApi["completeFinalize"]>()
      .mockImplementationOnce(async () => {
        throw new ControlApiError("temporary", 503, true);
      })
      .mockImplementation(async () => undefined);
    const control: ControlApi = { claim: vi.fn(), heartbeat: vi.fn(), retry: vi.fn(), complete: vi.fn(), claimFinalize: vi.fn(async () => ({ assignments: [current] })), completeFinalize, retryFinalize };
    let finalPutAttempts = 0;
    const output = vi.fn(async (url: string, init?: RequestInit) => {
      const chunk = current.chunks.find((candidate) => candidate.inputUrl === url);
      if (chunk) return new Response(new TextEncoder().encode(JSON.stringify(document)), { headers: { "content-type": "application/json" } });
      expect(init?.method).toBe("PUT");
      finalPutAttempts += 1;
      return new Response(null, { status: finalPutAttempts === 1 ? 201 : 412 });
    });

    const first = await runFinalizeDispatcher({ source: "finalize" }, { getRemainingTimeInMillis: () => 120_000 }, { ...dependencies(control, current, [document], output) });
    const second = await runFinalizeDispatcher({ source: "finalize" }, { getRemainingTimeInMillis: () => 120_000 }, { ...dependencies(control, current, [document], output) });

    expect(first).toMatchObject({ completed: 0, failed: 1 });
    expect(second).toMatchObject({ completed: 1, failed: 0 });
    expect(finalPutAttempts).toBe(2);
    expect(completeFinalize).toHaveBeenCalledTimes(2);
    expect(retryFinalize).toHaveBeenCalledWith(expect.objectContaining({ terminal: false }));
  });

  it("retries bounded download failures and terminally rejects invalid bounds", async () => {
    const document = chunkDocument({ cues: [{ startMs: -1, endMs: 100, identity: { kind: "unknown" }, trackClass: "unknown", text: "bad", overlap: false, provider: "cloudflare", model: "model", versionContract: "cf-1", attempt: 1 }] });
    const current = assignment([{ id: "a", start: 0, end: 200, document }]);
    const retryFinalize = vi.fn(async () => undefined);
    const control: ControlApi = { claim: vi.fn(), heartbeat: vi.fn(), retry: vi.fn(), complete: vi.fn(), claimFinalize: vi.fn(async () => ({ assignments: [current] })), completeFinalize: vi.fn(), retryFinalize };
    const retryable = await runFinalizeDispatcher(
      { source: "finalize" },
      { getRemainingTimeInMillis: () => 120_000 },
      {
        ...dependencies(
          control,
          current,
          [document],
          vi.fn(async () => new Response(null, { status: 503 })),
        ),
      },
    );
    expect(retryable).toMatchObject({ failed: 1 });
    expect(retryFinalize).toHaveBeenCalledWith(expect.objectContaining({ terminal: false }));

    retryFinalize.mockClear();
    const invalid = await runFinalizeDispatcher({ source: "finalize" }, { getRemainingTimeInMillis: () => 120_000 }, { ...dependencies(control, current, [document]) });
    expect(invalid).toMatchObject({ failed: 1 });
    expect(retryFinalize).toHaveBeenCalledWith(expect.objectContaining({ terminal: true }));
  });
});
