import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ProviderError } from "../src/errors.js";
import { MaiTranscribeProvider } from "../src/mai-provider.js";

// The body OpenRouter returned on 10 Nov 2026 when three chunks of one recording were in flight together on a nearly empty credit.
const observed = {
  error: {
    message: "This request would exceed your available credits given your current in-flight requests. Retry after in-flight requests settle, or add credits.",
    code: 402,
    metadata: { reason: "in_flight_budget_exhausted", limit_source: "openrouter_in_flight_budget" },
  },
};
const policy = { timeoutMs: 5000, maxAudioBytes: 1_000_000, maxAudioSeconds: 60, maxResponseBytes: 100_000, maxTextChars: 10_000, maxSegments: 100, maxWords: 1000, maxRetries: 0, retryBaseDelayMs: 0, retryMaxDelayMs: 0, circuitFailureThreshold: 5, circuitCooldownMs: 1000 };

describe("an OpenRouter 402 on a recording chunk", () => {
  it("becomes a retryable provider error that names the refusal reason", async () => {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify(observed), { status: 402, headers: { "content-type": "application/json" } });
    const provider = new MaiTranscribeProvider({ fetch: fetchImpl, token: "token", policy });
    const failure = await provider.transcribe({ audio: new Uint8Array(readFileSync(new URL("./fixtures/mai-speech.flac", import.meta.url))), contentType: "audio/flac", transcriptLanguage: { mode: "auto" } } as never).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderError);
    expect(failure).toMatchObject({ kind: "retryable", status: 402, providerCode: "in_flight_budget_exhausted" });
  });
});
