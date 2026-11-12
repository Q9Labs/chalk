import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors.js";
import { CLOUDFLARE_MODEL, DEEPINFRA_MODEL } from "../src/models.js";
import { CloudflareWhisperProvider, DeepInfraWhisperProvider } from "../src/providers.js";
import type { ProviderPolicy, ProviderRequest, ProviderResult, TranscriptionProvider } from "../src/provider-types.js";
import { InvocationCircuit, transcribeWithFallback } from "../src/retry.js";
import { expiringUrl } from "../src/wire-fields.js";

const policy: ProviderPolicy = {
  timeoutMs: 5_000,
  maxAudioBytes: 1_000,
  maxAudioSeconds: 60,
  maxResponseBytes: 100_000,
  maxTextChars: 10_000,
  maxSegments: 100,
  maxWords: 100,
  maxRetries: 2,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 2,
  circuitFailureThreshold: 3,
  circuitCooldownMs: 1_000,
};

const request: ProviderRequest = { audio: new Uint8Array([1, 2, 3]), contentType: "audio/flac", chunkId: "chunk-1" };

const goodBody = { text: "hello there", segments: [{ start: 0, end: 1, text: "hello there" }] };

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function deepInfra(respond: () => Response | Promise<Response>, extra: Partial<ConstructorParameters<typeof DeepInfraWhisperProvider>[0]> = {}): DeepInfraWhisperProvider {
  return new DeepInfraWhisperProvider({ fetch: async () => respond(), token: "t", policy, ...extra });
}

function cloudflare(respond: () => Response): CloudflareWhisperProvider {
  return new CloudflareWhisperProvider({ fetch: async () => respond(), token: "t", accountId: "acct", policy, adapterContractVersion: "cf.v1" });
}

describe("DeepInfraWhisperProvider", () => {
  it("parses timings, converts reported cents to USD and records the observed version", async () => {
    const provider = deepInfra(() => json({ ...goodBody, model_version: "v7", inference_status: { cost: 50 } }));
    const result = await provider.transcribe(request);
    expect(result).toMatchObject({ provider: "deepinfra", model: DEEPINFRA_MODEL, text: "hello there", providerReportedCostUsd: 0.5, providerIdentity: { modelVersion: "v7" } });
    expect(result.segments).toEqual([{ startSeconds: 0, endSeconds: 1, text: "hello there" }]);
  });

  it("rejects a response whose version differs from the pin", async () => {
    const provider = deepInfra(() => json({ ...goodBody, model_version: "v8" }), { modelVersionPin: "v7" });
    await expect(provider.transcribe(request)).rejects.toMatchObject({ kind: "schema", message: "provider model version mismatched release" });
  });

  it("rejects audio over the bound before sending anything", async () => {
    const provider = deepInfra(() => {
      throw new Error("unreachable");
    });
    await expect(provider.transcribe({ ...request, audio: new Uint8Array(1_001) })).rejects.toMatchObject({ kind: "schema" });
    await expect(provider.transcribe({ ...request, contentType: "text/plain" })).rejects.toMatchObject({ kind: "schema" });
  });

  it("classifies failures by status and keeps a numeric provider code", async () => {
    await expect(deepInfra(() => json({ errors: [{ code: 1234 }] }, { status: 429 })).transcribe(request)).rejects.toMatchObject({ kind: "retryable", status: 429, providerCode: "1234" });
    await expect(deepInfra(() => json({}, { status: 400 })).transcribe(request)).rejects.toMatchObject({ kind: "nonretryable", status: 400 });
  });

  it("maps a network failure to retryable and a timeout to timeout", async () => {
    const network = deepInfra(() => {
      throw new TypeError("fetch failed");
    });
    await expect(network.transcribe(request)).rejects.toMatchObject({ kind: "retryable" });
    const timeout = deepInfra(() => {
      throw new DOMException("late", "TimeoutError");
    });
    await expect(timeout.transcribe(request)).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("CloudflareWhisperProvider", () => {
  it("reads the result envelope and merges its request ID and model", async () => {
    const result = await cloudflare(() => json({ result: goodBody, request_id: "req-1", model: CLOUDFLARE_MODEL })).transcribe(request);
    expect(result).toMatchObject({ provider: "cloudflare", versionContract: "cf.v1", providerIdentity: { requestId: "req-1", model: CLOUDFLARE_MODEL } });
  });

  it("rejects an envelope model that is not the release model", async () => {
    await expect(cloudflare(() => json({ result: goodBody, model: "other" })).transcribe(request)).rejects.toMatchObject({ kind: "schema", message: "provider model identity mismatched release" });
  });

  it("treats the transient 429 code as retryable and other 429s as final", async () => {
    await expect(cloudflare(() => json({ errors: [{ code: 3040 }] }, { status: 429 })).transcribe(request)).rejects.toMatchObject({ kind: "retryable" });
    await expect(cloudflare(() => json({ errors: [{ code: 1000 }] }, { status: 429 })).transcribe(request)).rejects.toMatchObject({ kind: "nonretryable" });
  });
});

describe("transcribeWithFallback", () => {
  const result: ProviderResult = { text: "ok", segments: [{ startSeconds: 0, endSeconds: 1, text: "ok" }], provider: "deepinfra", model: "m", versionContract: "v" };
  const runtime = { sleep: async () => undefined, random: () => 0.5, now: () => 0 };

  function scripted(...steps: Array<ProviderError | ProviderResult>): TranscriptionProvider & { calls: number } {
    const provider = {
      name: "deepinfra" as const,
      calls: 0,
      async transcribe(): Promise<ProviderResult> {
        const step = steps[Math.min(provider.calls, steps.length - 1)];
        provider.calls += 1;
        if (step instanceof ProviderError) throw step;
        return step as ProviderResult;
      },
    };
    return provider;
  }

  const run = (primary: TranscriptionProvider | undefined, fallback?: TranscriptionProvider, circuit = new InvocationCircuit(3, 1_000)) =>
    transcribeWithFallback({ ...(primary ? { primary } : {}), ...(fallback ? { fallback } : {}), request, policy, circuit, runtime });

  it("retries a transient failure on the primary and counts attempts", async () => {
    const primary = scripted(new ProviderError("x", "retryable"), result);
    await expect(run(primary)).resolves.toMatchObject({ providerAttempts: 2, usedFallback: false });
  });

  it("goes to the fallback at once for a final failure", async () => {
    const primary = scripted(new ProviderError("x", "nonretryable"));
    const fallback = scripted(result);
    await expect(run(primary, fallback)).resolves.toMatchObject({ providerAttempts: 2, usedFallback: true });
    expect(primary.calls).toBe(1);
  });

  it("stops after maxRetries and rethrows the last failure when there is no fallback", async () => {
    const primary = scripted(new ProviderError("down", "retryable"));
    await expect(run(primary)).rejects.toThrow("down");
    expect(primary.calls).toBe(3);
  });

  it("skips the primary while its circuit is open", async () => {
    const circuit = new InvocationCircuit(1, 1_000);
    circuit.recordFailure(0);
    const primary = scripted(result);
    await expect(run(primary, scripted(result), circuit)).resolves.toMatchObject({ providerAttempts: 1, usedFallback: true });
    expect(primary.calls).toBe(0);
  });

  it("fails when no provider is available", async () => {
    await expect(run(undefined)).rejects.toThrow("no available transcription provider");
  });
});

describe("expiringUrl", () => {
  const ttl = 15 * 60_000;
  const signed = (query: string) => `https://objects.example.test/file?${query}`;
  const stamp = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString().replace(/[-:]|\.\d{3}/g, "");

  it("accepts a short-lived URL and rejects the unsafe shapes", () => {
    expect(expiringUrl(signed(`X-Amz-Expires=300&X-Amz-Date=${stamp(0)}`), "url", ttl)).toContain("X-Amz-Expires=300");
    expect(() => expiringUrl("http://objects.example.test/f?expires=300", "url", ttl)).toThrow("url must use HTTPS");
    expect(() => expiringUrl("not a url", "url", ttl)).toThrow("url is invalid");
    expect(() => expiringUrl(signed("a=1"), "url", ttl)).toThrow("url has no short-lived expiry");
    expect(() => expiringUrl(signed("X-Amz-Expires=3600"), "url", ttl)).toThrow("url exceeds short-lived TTL");
    expect(() => expiringUrl(signed("X-Amz-Expires=0"), "url", ttl)).toThrow("url exceeds short-lived TTL");
    expect(() => expiringUrl(signed(`X-Amz-Expires=300&X-Amz-Date=${stamp(-3_600_000)}`), "url", ttl)).toThrow("url is expired");
    expect(() => expiringUrl(signed("X-Amz-Expires=300&X-Amz-Date=garbage"), "url", ttl)).toThrow("url signing date is invalid");
  });
});
