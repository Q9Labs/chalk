import { describe, expect, it, vi } from "vitest";
import { ProviderError } from "../src/errors.js";
import { CloudflareWhisperProvider, DeepInfraWhisperProvider } from "../src/providers.js";
import type { ProviderPolicy } from "../src/types.js";

const policy: ProviderPolicy = {
  timeoutMs: 1_000,
  maxAudioBytes: 10_000,
  maxAudioSeconds: 120,
  maxResponseBytes: 10_000,
  maxTextChars: 1_000,
  maxSegments: 10,
  maxWords: 100,
  maxRetries: 1,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 10,
  circuitFailureThreshold: 2,
  circuitCooldownMs: 100,
};

const verbose = { text: "hello", language: "en", duration: 1, segments: [{ start: 0, end: 1, text: "hello" }], words: [{ start: 0, end: 1, word: "hello" }] };

describe("provider adapters", () => {
  it("maps DeepInfra multipart requests and requires observed execution identity", async () => {
    let requestBody: FormData | undefined;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      requestBody = init?.body as FormData;
      return new Response(JSON.stringify(verbose), { headers: { "content-type": "application/json", "x-deepinfra-execution-identity": "exec-1", "x-deepinfra-model-version": "model-1" } });
    });
    const provider = new DeepInfraWhisperProvider({ fetch, token: "secret", executionIdentityPin: "exec-1", modelVersionPin: "model-1", policy });
    const result = await provider.transcribe({ audio: new Uint8Array([1, 2]), contentType: "audio/mpeg", chunkId: "opaque" });
    expect(result.executionIdentity).toBe("exec-1");
    expect(requestBody?.get("model")).toBe("openai/whisper-large-v3-turbo");
    expect(requestBody?.getAll("timestamp_granularities")).toEqual(["segment", "word"]);
  });

  it("rejects DeepInfra without an independently observed identity", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(verbose), { headers: { "content-type": "application/json" } }));
    const provider = new DeepInfraWhisperProvider({ fetch, token: "secret", executionIdentityPin: "exec-1", modelVersionPin: "model-1", policy });
    await expect(provider.transcribe({ audio: new Uint8Array([1]), contentType: "audio/mpeg", chunkId: "opaque" })).rejects.toMatchObject({ kind: "schema" });
  });

  it("rejects oversized provider bodies before parsing them", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(verbose), { headers: { "content-length": "100000" } }));
    const provider = new CloudflareWhisperProvider({ fetch, token: "secret", accountId: "account", policy: { ...policy, maxResponseBytes: 10 }, adapterContractVersion: "cf-contract-1" });
    await expect(provider.transcribe({ audio: new Uint8Array([1]), contentType: "audio/mpeg", chunkId: "opaque" })).rejects.toMatchObject({ kind: "schema" });
  });

  it("uses an unencoded Cloudflare model path and rejects text-only attribution", async () => {
    let requestUrl = "";
    const fetch = vi.fn(async (url: string) => {
      requestUrl = url;
      return new Response(JSON.stringify({ result: { text: "hello" } }));
    });
    const provider = new CloudflareWhisperProvider({ fetch, token: "secret", accountId: "account", policy, adapterContractVersion: "cf-contract-1" });
    await expect(provider.transcribe({ audio: new Uint8Array([1]), contentType: "audio/mpeg", chunkId: "opaque" })).rejects.toMatchObject({ kind: "schema" });
    expect(requestUrl).toContain("/ai/run/@cf/openai/whisper-large-v3-turbo");
  });

  it("retains a Cloudflare request identity when the response exposes one", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ result: verbose, request_id: "cf-request-1" })));
    const provider = new CloudflareWhisperProvider({ fetch, token: "secret", accountId: "account", policy, adapterContractVersion: "cf-contract-1" });
    const result = await provider.transcribe({ audio: new Uint8Array([1]), contentType: "audio/mpeg", chunkId: "opaque" });
    expect(result.providerIdentity?.requestId).toBe("cf-request-1");
  });

  it("classifies Cloudflare allocation exhaustion as non-retryable", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: 3036 }] }), { status: 429 }));
    const provider = new CloudflareWhisperProvider({ fetch, token: "secret", accountId: "account", policy, adapterContractVersion: "cf-contract-1" });
    try {
      await provider.transcribe({ audio: new Uint8Array([1]), contentType: "audio/mpeg", chunkId: "opaque" });
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind).toBe("nonretryable");
    }
  });
});
