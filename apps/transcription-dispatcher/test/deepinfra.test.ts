import { describe, expect, it } from "vitest";

import { loadReleaseConfig } from "../src/config.js";
import { ProviderError } from "../src/errors.js";
import { DeepInfraWhisperProvider } from "../src/providers.js";
import { InvocationCircuit, transcribeWithFallback } from "../src/retry.js";
import { loadDispatcherSecrets } from "../src/secrets.js";
import type { ProviderPolicy } from "../src/types.js";

const policy: ProviderPolicy = {
  timeoutMs: 1_000,
  maxAudioBytes: 1024,
  maxAudioSeconds: 900,
  maxResponseBytes: 4096,
  maxTextChars: 1024,
  maxSegments: 100,
  maxWords: 100,
  maxRetries: 1,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 1,
  circuitFailureThreshold: 5,
  circuitCooldownMs: 1_000,
};
const request = { audio: new Uint8Array([1, 2]), contentType: "audio/flac", chunkId: "chunk-1" };
const nativeResponse = {
  text: "Hello",
  segments: [{ start: 0, end: 1, text: "Hello" }],
  words: [{ start: 0, end: 1, text: "Hello" }],
  language: "en",
  duration: 1,
  input_length_ms: 1000,
  request_id: null,
  inference_status: { status: "succeeded", cost: 0.000333 },
};

describe("direct DeepInfra contract", () => {
  it.each(["AbortError", "TimeoutError"])("classifies %s as a bounded provider timeout", async (name) => {
    const provider = new DeepInfraWhisperProvider({
      policy,
      token: "test-token",
      fetch: async () => {
        throw new DOMException("request aborted", name);
      },
    });
    await expect(provider.transcribe(request)).rejects.toMatchObject({ kind: "timeout" });
  });

  it("rejects a provider response beyond the configured byte bound", async () => {
    const provider = new DeepInfraWhisperProvider({ policy, token: "test-token", fetch: async () => Response.json({ ...nativeResponse, text: "x".repeat(5000) }) });
    await expect(provider.transcribe(request)).rejects.toBeInstanceOf(ProviderError);
  });

  it("sends only the documented native multipart request, without redirects or fabricated identity", async () => {
    const provider = new DeepInfraWhisperProvider({
      policy,
      token: "test-token",
      fetch: async (url, init) => {
        expect(url).toBe("https://api.deepinfra.com/v1/inference/openai/whisper-large-v3-turbo");
        expect(init?.redirect).toBe("error");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
        const body = init?.body;
        if (!(body instanceof FormData)) throw new Error("expected multipart body");
        expect([...body.keys()]).toEqual(["audio"]);
        const audio = body.get("audio");
        if (!(audio instanceof Blob)) throw new Error("expected audio upload");
        expect(audio.type).toBe("audio/flac");
        expect(new Uint8Array(await audio.arrayBuffer())).toEqual(request.audio);
        return Response.json(nativeResponse);
      },
    });
    const result = await provider.transcribe(request);
    expect(result.words).toEqual([{ startSeconds: 0, endSeconds: 1, word: "Hello" }]);
    expect(result.versionContract).toBe("deepinfra-native-whisper-turbo.v1");
    expect(result.providerIdentity).toBeUndefined();
    expect(result.executionIdentity).toBeUndefined();
    expect(result.providerReportedCostUsd).toBeCloseTo(0.00000333, 12);
  });

  it.each([
    [0, 0],
    [0.01998, 0.0001998],
    [1_000, 10],
  ])("converts native cost %s cents to %s USD", async (cost, expectedUsd) => {
    const provider = new DeepInfraWhisperProvider({ policy, token: "test-token", fetch: async () => Response.json({ ...nativeResponse, inference_status: { status: "succeeded", cost } }) });
    expect((await provider.transcribe(request)).providerReportedCostUsd).toBeCloseTo(expectedUsd, 12);
  });

  it("keeps observed metadata separate from the adapter contract", async () => {
    const provider = new DeepInfraWhisperProvider({ policy, token: "test-token", fetch: async () => Response.json({ ...nativeResponse, request_id: "request-1", model_version: "observed-1", execution_identity: "observed-runtime" }) });
    expect(await provider.transcribe(request)).toMatchObject({
      versionContract: "deepinfra-native-whisper-turbo.v1",
      providerIdentity: { requestId: "request-1", modelVersion: "observed-1" },
      executionIdentity: "observed-runtime",
    });
  });

  it("fails closed when an optional pin has no matching evidence", async () => {
    const provider = new DeepInfraWhisperProvider({ policy, token: "test-token", modelVersionPin: "expected-version", fetch: async () => Response.json(nativeResponse) });
    await expect(provider.transcribe(request)).rejects.toThrow(/model version mismatched/);
  });

  it("rejects conflicting identity evidence", async () => {
    const provider = new DeepInfraWhisperProvider({ policy, token: "test-token", fetch: async () => Response.json({ ...nativeResponse, execution_identity: "one" }, { headers: { "x-execution-identity": "two" } }) });
    await expect(provider.transcribe(request)).rejects.toThrow(/inconsistent/);
  });

  it("does not estimate missing charges and rejects malformed reported charges", async () => {
    const missing = new DeepInfraWhisperProvider({ policy, token: "test-token", fetch: async () => Response.json({ ...nativeResponse, inference_status: null }) });
    expect((await missing.transcribe(request)).providerReportedCostUsd).toBeUndefined();
    const invalid = new DeepInfraWhisperProvider({ policy, token: "test-token", fetch: async () => Response.json({ ...nativeResponse, inference_status: { cost: -1 } }) });
    await expect(invalid.transcribe(request)).rejects.toThrow(/reported cost/);
  });

  it("retries only DeepInfra when fallback is disabled and never invents a result", async () => {
    let calls = 0;
    const primary = new DeepInfraWhisperProvider({
      policy,
      token: "test-token",
      fetch: async () => {
        calls++;
        return Response.json({}, { status: 429 });
      },
    });
    await expect(transcribeWithFallback({ primary, request, policy, circuit: new InvocationCircuit(5, 1_000), runtime: { sleep: async () => undefined, random: () => 0, now: () => 0 } })).rejects.toBeInstanceOf(ProviderError);
    expect(calls).toBe(2);
  });
});

describe("provider selection", () => {
  const env = {
    CHALK_ENVIRONMENT: "qualification",
    CHALK_RELEASE_ID: "test",
    CONTROL_API_AUDIENCE: "test",
    CONTROL_API_BASE_URL: "https://api.example.test",
    TRANSCRIPTION_MAX_BATCH: "3",
    TRANSCRIPTION_CONCURRENCY: "3",
    TRANSCRIPTION_TIMEOUT_RESERVE_MS: "60000",
    TRANSCRIPTION_PRIVACY_GATE_ACCEPTED: "true",
    DEEPINFRA_ENABLED: "true",
    DEEPINFRA_ADAPTER_CONTRACT_VERSION: "deepinfra-native-whisper-turbo.v1",
    DEEPINFRA_CORPUS_DIGEST: "a".repeat(64),
    CLOUDFLARE_AI_ENABLED: "false",
    TRANSCRIPTION_PROVIDER_TIMEOUT_MS: "1000",
    TRANSCRIPTION_MAX_AUDIO_BYTES: "1024",
    TRANSCRIPTION_MAX_AUDIO_SECONDS: "900",
    TRANSCRIPTION_MAX_RESPONSE_BYTES: "4096",
    TRANSCRIPTION_MAX_TEXT_CHARS: "1024",
    TRANSCRIPTION_MAX_SEGMENTS: "100",
    TRANSCRIPTION_MAX_WORDS: "100",
    TRANSCRIPTION_MAX_RETRIES: "1",
    TRANSCRIPTION_RETRY_BASE_DELAY_MS: "1",
    TRANSCRIPTION_RETRY_MAX_DELAY_MS: "1",
    TRANSCRIPTION_CIRCUIT_FAILURE_THRESHOLD: "5",
    TRANSCRIPTION_CIRCUIT_COOLDOWN_MS: "1000",
  };

  it("loads a DeepInfra-only release without any Cloudflare credentials or identity pins", () => {
    expect(loadReleaseConfig(env, { workloadAuth: "test-key", deepInfraToken: "test-token" }).cloudflare).toEqual({ enabled: false });
  });

  it("requires explicit fallback selection and qualification", () => {
    expect(() => loadReleaseConfig({ ...env, CLOUDFLARE_AI_ENABLED: "true" }, { workloadAuth: "test-key", deepInfraToken: "test-token" })).toThrow(/Cloudflare/);
    expect(() => loadReleaseConfig({ ...env, DEEPINFRA_CORPUS_DIGEST: "" }, { workloadAuth: "test-key", deepInfraToken: "test-token" })).toThrow(/CORPUS_DIGEST/);
    expect(() => loadReleaseConfig({ ...env, DEEPINFRA_ENABLED: "false" }, { workloadAuth: "test-key" })).toThrow(/at least one/);
  });

  it("requests only selected provider credentials from SSM", async () => {
    const secrets = await loadDispatcherSecrets(
      {
        send: async (command) => {
          expect(command.input.Names).toEqual(["/test/workload", "/test/deepinfra"]);
          return {
            Parameters: [
              { Name: "/test/workload", Value: "key" },
              { Name: "/test/deepinfra", Value: "token" },
            ],
          };
        },
      },
      { workloadAuth: "/test/workload", deepInfraToken: "/test/deepinfra" },
    );
    expect(secrets).toEqual({ workloadAuth: "key", deepInfraToken: "token" });
  });
});
