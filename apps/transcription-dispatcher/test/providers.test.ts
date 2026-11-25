import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors.js";
import type { ProviderPolicy, ProviderRequest, ProviderResult, TranscriptionProvider } from "../src/provider-types.js";
import { InvocationCircuit, transcribeWithRetry } from "../src/retry.js";
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

describe("transcribeWithRetry", () => {
  const result: ProviderResult = { text: "ok", segments: [{ startSeconds: 0, endSeconds: 1, text: "ok" }], provider: "openrouter", model: "m", versionContract: "v" };
  const runtime = { sleep: async () => undefined, random: () => 0.5, now: () => 0 };

  function scripted(...steps: Array<ProviderError | ProviderResult>): TranscriptionProvider & { calls: number } {
    const provider = {
      name: "openrouter" as const,
      calls: 0,
      async transcribe(): Promise<ProviderResult> {
        const step = steps[Math.min(provider.calls, steps.length - 1)];
        if (!step) throw new Error("test provider has no scripted outcome");
        provider.calls += 1;
        if (step instanceof ProviderError) throw step;
        return step;
      },
    };
    return provider;
  }

  const run = (provider: TranscriptionProvider, circuit = new InvocationCircuit(3, 1_000)) => transcribeWithRetry({ provider, request, policy, circuit, runtime });

  it("retries a transient failure and counts attempts", async () => {
    const provider = scripted(new ProviderError("transient", "retryable"), result);
    await expect(run(provider)).resolves.toEqual({ result, providerAttempts: 2 });
  });

  it("returns a final failure without retrying", async () => {
    const provider = scripted(new ProviderError("rejected", "nonretryable"));
    await expect(run(provider)).rejects.toThrow("rejected");
    expect(provider.calls).toBe(1);
  });

  it("stops after maxRetries and rethrows the last failure", async () => {
    const provider = scripted(new ProviderError("down", "retryable"));
    await expect(run(provider)).rejects.toThrow("down");
    expect(provider.calls).toBe(3);
  });

  it("does not call the provider while its circuit is open", async () => {
    const circuit = new InvocationCircuit(1, 1_000);
    circuit.recordFailure(0);
    const provider = scripted(result);
    await expect(run(provider, circuit)).rejects.toMatchObject({ kind: "retryable" });
    expect(provider.calls).toBe(0);
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
