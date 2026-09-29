import { describe, expect, it } from "vitest";
import { runFinalizeDispatcher } from "../src/finalizer.js";
import type { DispatcherDependencies } from "../src/dispatcher.js";
import type { ReleaseConfig } from "../src/types.js";

const config: ReleaseConfig = {
  environment: "test",
  releaseId: "test-release",
  controlApiAudience: "test-audience",
  controlApiBaseUrl: "https://control.example.test",
  maxBatch: 1,
  concurrency: 1,
  timeoutReserveMs: 1_000,
  privacyGateAccepted: true,
  deepInfra: { enabled: false, model: "openai/whisper-large-v3-turbo" },
  cloudflare: { enabled: false },
  provider: {
    timeoutMs: 10_000,
    maxAudioBytes: 1_024,
    maxAudioSeconds: 900,
    maxResponseBytes: 1_024,
    maxTextChars: 1_024,
    maxSegments: 100,
    maxWords: 100,
    maxRetries: 0,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 1,
    circuitFailureThreshold: 5,
    circuitCooldownMs: 1_000,
  },
};

describe("transcription finalizer failures", () => {
  it("logs the safe failure code even when reporting the retry also fails", async () => {
    const warnings: Array<{ event: string; fields?: Record<string, string | number | boolean> }> = [];
    const assignment = {
      jobId: "job-1",
      transcriptId: "transcript-1",
      episodeId: "episode-1",
      attempt: 2,
      leaseToken: "lease",
      leaseExpiresAt: "2030-01-01T00:00:00Z",
      chunks: [
        {
          chunkId: "chunk-1",
          inputUrl: "https://objects.example.test/chunk",
          inputUrlExpiresAt: "2030-01-01T00:00:00Z",
          inputContentType: "application/json" as const,
          inputSizeBytes: 1,
          inputSha256: "a".repeat(64),
          episodeStartMs: 0,
          episodeEndMs: 1_000,
        },
      ],
      outputPutUrl: "https://objects.example.test/output",
      outputPutUrlExpiresAt: "2030-01-01T00:00:00Z",
      outputContentType: "application/json" as const,
    };
    const dependencies: DispatcherDependencies = {
      config,
      control: {
        claim: async () => ({ assignments: [] }),
        heartbeat: async () => undefined,
        retry: async () => undefined,
        complete: async () => undefined,
        claimFinalize: async () => ({ assignments: [assignment] }),
        heartbeatFinalize: async () => undefined,
        completeFinalize: async () => undefined,
        retryFinalize: async () => {
          throw new Error("retry unavailable");
        },
      },
      fetch: async () => {
        throw new TypeError("request failed");
      },
      logger: {
        info: () => undefined,
        warn: (event, fields) => {
          warnings.push({ event, ...(fields === undefined ? {} : { fields }) });
        },
      },
    };

    const result = await runFinalizeDispatcher({}, { getRemainingTimeInMillis: () => 30_000 }, dependencies);

    expect(result).toEqual({ claimed: 1, completed: 0, failed: 1 });
    expect(warnings).toContainEqual({ event: "finalize_failed", fields: { error: "network_failure", attempt: 2, terminal: false } });
    expect(warnings).toContainEqual({ event: "finalize_retry_report_failed", fields: { error: "dispatcher_failure" } });
  });
});
