import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RecorderControlApiClient } from "../src/control-api.js";
import { runDispatcher } from "../src/dispatcher.js";
import { HmacWorkloadSigner } from "../src/workload-auth.js";
import { ProviderError } from "../src/errors.js";
import type { ControlApi, ReleaseConfig, TranscriptionAssignment, TranscriptionProvider } from "../src/types.js";

const config: ReleaseConfig = {
  environment: "test",
  releaseId: "release-1",
  controlApiAudience: "chalk-control-api",
  controlApiBaseUrl: "https://control.example",
  maxBatch: 10,
  concurrency: 2,
  timeoutReserveMs: 60_000,
  privacyGateAccepted: true,
  deepInfra: { enabled: false, model: "openai/whisper-large-v3-turbo" },
  cloudflare: { token: "secret", accountId: "account", modelSlug: "@cf/openai/whisper-large-v3-turbo", adapterContractVersion: "cf-1", corpusDigest: "a".repeat(64) },
  provider: { timeoutMs: 1_000, maxAudioBytes: 10_000, maxAudioSeconds: 60, maxResponseBytes: 10_000, maxTextChars: 1_000, maxSegments: 10, maxWords: 100, maxRetries: 0, retryBaseDelayMs: 1, retryMaxDelayMs: 2, circuitFailureThreshold: 2, circuitCooldownMs: 100 },
};

const audio = new Uint8Array([1, 2, 3]);
const manifestBytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: "manifest.v1", turns: [{ startMs: 0, endMs: 1_000, identity: { kind: "unknown" }, trackClass: "unknown", overlap: false }] }));
const assignment: TranscriptionAssignment = {
  jobId: "job",
  sessionId: "session",
  attempt: 1,
  leaseToken: "lease",
  leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  chunk: {
    chunkId: "chunk",
    inputUrl: "https://r2.example/input",
    inputUrlExpiresAt: new Date(Date.now() + 300_000).toISOString(),
    inputContentType: "audio/mpeg",
    inputSizeBytes: audio.byteLength,
    inputSha256: createHash("sha256").update(audio).digest("hex"),
    meetingStartMs: 0,
    meetingEndMs: 1_000,
    sourceIdentity: { kind: "unknown" },
    sourceTrackClass: "unknown",
  },
  manifest: { inputUrl: "https://r2.example/manifest", expiresAt: new Date(Date.now() + 300_000).toISOString(), contentType: "application/json", sizeBytes: manifestBytes.byteLength, sha256: createHash("sha256").update(manifestBytes).digest("hex") },
  outputPutUrl: "https://r2.example/output",
  outputPutUrlExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  outputContentType: "application/json",
};

const provider: TranscriptionProvider = {
  name: "cloudflare",
  transcribe: async () => ({ text: "hello", segments: [{ startSeconds: 0, endSeconds: 1, text: "hello" }], provider: "cloudflare", model: "@cf/openai/whisper-large-v3-turbo", versionContract: "cf-1" }),
};

describe("dispatcher runtime and control boundary", () => {
  it("processes a reconciliation wake and completes using checksum metadata, not URL authority", async () => {
    const complete = vi.fn();
    const control: ControlApi = {
      claim: vi.fn(async () => ({ assignments: [assignment] })),
      heartbeat: vi.fn(async () => undefined),
      retry: vi.fn(async () => undefined),
      complete,
    };
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/input")) return new Response(audio, { headers: { "content-type": "audio/mpeg", "content-length": "3" } });
      if (url.endsWith("/manifest")) return new Response(manifestBytes, { headers: { "content-type": "application/json", "content-length": String(manifestBytes.byteLength) } });
      expect(init?.method).toBe("PUT");
      expect(init?.headers).toMatchObject({ "if-none-match": "*", "content-type": "application/json" });
      return new Response(null, { status: 201 });
    });
    const result = await runDispatcher({ source: "reconcile", journeyId: "journey" }, { getRemainingTimeInMillis: () => 120_000 }, { config, control, fallback: provider, fetch });
    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ jobId: "job", checksumSha256: expect.any(String), sizeBytes: expect.any(Number), contentType: "application/json" }));
    expect(complete.mock.calls[0]?.[0]).not.toHaveProperty("resultPutUrl");
  });

  it("does not claim when the Lambda timeout reserve is reached", async () => {
    const claim = vi.fn(async () => ({ assignments: [] }));
    const control: ControlApi = { claim, heartbeat: vi.fn(), retry: vi.fn(), complete: vi.fn() };
    const result = await runDispatcher({ source: "wake" }, { getRemainingTimeInMillis: () => 60_000 }, { config, control, fallback: provider, fetch: vi.fn() });
    expect(result).toEqual({ claimed: 0, completed: 0, failed: 0 });
    expect(claim).not.toHaveBeenCalled();
  });

  it("reconciliation reaches transcription, finalization, and cleanup queues within one shared budget", async () => {
    const claimFinalize = vi.fn(async () => ({ assignments: [] }));
    const claimCleanup = vi.fn(async () => ({ assignments: [] }));
    const control: ControlApi = {
      claim: vi.fn(async () => ({ assignments: [] })),
      heartbeat: vi.fn(),
      retry: vi.fn(),
      complete: vi.fn(),
      claimFinalize,
      completeFinalize: vi.fn(),
      retryFinalize: vi.fn(),
      claimCleanup,
      completeCleanup: vi.fn(),
      retryCleanup: vi.fn(),
    };
    const result = await runDispatcher({ source: "eventbridge.scheduler", kind: "transcription-reconcile", journeyId: "journey" }, { getRemainingTimeInMillis: () => 120_000 }, { config: { ...config, concurrency: 3 }, control, fallback: provider, fetch: vi.fn() });
    expect(result).toEqual({ claimed: 0, completed: 0, failed: 0 });
    expect(control.claim).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    expect(claimFinalize).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    expect(claimCleanup).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
  });

  it("redacts provider details from dispatcher telemetry", async () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const control: ControlApi = { claim: vi.fn(async () => ({ assignments: [assignment] })), heartbeat: vi.fn(async () => undefined), retry: vi.fn(async () => undefined), complete: vi.fn() };
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/input")) return new Response(audio, { headers: { "content-type": "audio/mpeg", "content-length": "3" } });
      return new Response(manifestBytes, { headers: { "content-type": "application/json", "content-length": String(manifestBytes.byteLength) } });
    });
    const secretProvider: TranscriptionProvider = {
      name: "cloudflare",
      transcribe: async () => {
        throw new ProviderError("token=secret audio=https://private", "nonretryable");
      },
    };
    await runDispatcher({ source: "wake", journeyId: "journey" }, { getRemainingTimeInMillis: () => 120_000 }, { config, control, fallback: secretProvider, fetch, logger });
    const telemetry = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(telemetry).not.toContain("secret");
    expect(telemetry).not.toContain("https://private");
  });

  it("propagates journey and trace headers and uses internal snake_case endpoints", async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ assignments: [] }));
    });
    const client = new RecorderControlApiClient({ baseUrl: "https://control.example", signer: new HmacWorkloadSigner({ secret: "workload-secret", environment: "test", releaseId: "release-1", audience: "chalk-control-api", now: () => 1_700_000_000_000, nonce: () => "nonce-123456789012" }), fetch });
    await client.claim({ limit: 3, context: { journeyId: "journey", traceparent: "00-trace", tracestate: "vendor" } });
    await client.retry({ jobId: "job", attempt: 1, leaseToken: "lease", errorCode: "timeout", terminal: false, context: { journeyId: "journey" } });
    expect(seen[0]?.url).toBe("https://control.example/internal/v1/transcription/jobs/claim");
    expect(seen[0]?.init?.headers).toMatchObject({
      authorization: expect.stringContaining("Chalk-Workload-HMAC"),
      "x-chalk-journey-id": "journey",
      traceparent: "00-trace",
      tracestate: "vendor",
      "x-chalk-workload-nonce": "nonce-123456789012",
      "x-chalk-workload-audience": "chalk-control-api",
      "x-chalk-workload-body-sha256": expect.any(String),
    });
    expect(seen[1]?.url).toBe("https://control.example/internal/v1/transcription/jobs/retry");
    expect(JSON.parse(String(seen[1]?.init?.body))).toMatchObject({ job_id: "job", lease_token: "lease", error_code: "timeout" });
  });

  it("uses the fenced finalization claim, complete, and retry wire", async () => {
    const expiry = new Date(Date.now() + 300_000).toISOString();
    const bytes = new TextEncoder().encode(JSON.stringify({ schemaVersion: "transcript.v1" }));
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      if (url.endsWith("/claim"))
        return new Response(
          JSON.stringify({
            assignments: [
              {
                job_id: "final-job",
                transcript_id: "transcript",
                session_id: "session",
                attempt: 1,
                lease_token: "lease",
                lease_expires_at: expiry,
                chunks: [
                  {
                    chunk_id: "chunk",
                    input_url: "https://r2.example/chunk?X-Amz-Expires=900",
                    input_url_expires_at: expiry,
                    input_content_type: "application/json",
                    input_size_bytes: bytes.byteLength,
                    input_sha256: createHash("sha256").update(bytes).digest("hex"),
                    meeting_start_ms: 0,
                    meeting_end_ms: 1_000,
                  },
                ],
                output_put_url: "https://r2.example/final?X-Amz-Expires=900",
                output_put_url_expires_at: expiry,
                output_content_type: "application/json",
              },
            ],
          }),
        );
      return new Response(null, { status: 204 });
    });
    const client = new RecorderControlApiClient({ baseUrl: "https://control.example", signer: new HmacWorkloadSigner({ secret: "workload-secret", environment: "test", releaseId: "release-1", audience: "chalk-control-api", now: () => 1_700_000_000_000, nonce: () => "nonce-123456789012" }), fetch });
    const claimed = await client.claimFinalize({ limit: 1, context: { journeyId: "journey" } });
    expect(claimed.assignments[0]?.transcriptId).toBe("transcript");
    await client.completeFinalize({ jobId: "final-job", attempt: 1, leaseToken: "lease", checksumSha256: "a".repeat(64), sizeBytes: 100, contentType: "application/json", provider: "mixed", model: "mixed", versionContract: "mixed", languages: ["en", "fr"], context: { journeyId: "journey" } });
    await client.retryFinalize({ jobId: "final-job", attempt: 1, leaseToken: "lease", errorCode: "assignment_invalid", terminal: true, context: { journeyId: "journey" } });
    expect(seen.map((entry) => entry.url)).toEqual(["https://control.example/internal/v1/transcription/finalize/claim", "https://control.example/internal/v1/transcription/finalize/complete", "https://control.example/internal/v1/transcription/finalize/retry"]);
    expect(JSON.parse(String(seen[1]?.init?.body))).toMatchObject({ result_sha256: "a".repeat(64), languages: ["en", "fr"], provider: "mixed" });
    expect(JSON.parse(String(seen[2]?.init?.body))).toMatchObject({ job_id: "final-job", terminal: true });
  });
});
