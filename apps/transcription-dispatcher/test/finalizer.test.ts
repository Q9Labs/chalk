import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { RecorderControlApiClient } from "../src/control-api.js";
import { runFinalizeDispatcher } from "../src/finalizer.js";
import { HmacWorkloadSigner } from "../src/workload-auth.js";
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
  it.each([
    { failure: "download", errorCode: "network_failure", terminal: false },
    { failure: "merge", errorCode: "assignment_invalid", terminal: true },
  ])("reports $failure failures through the real control client before the lease expires", async ({ failure, errorCode, terminal }) => {
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const body = "{}";
    const retryBodies: string[] = [];
    const warnings: string[] = [];
    const control = new RecorderControlApiClient({
      baseUrl: "https://control.example.test",
      signer: new HmacWorkloadSigner({ secret: "test-secret", environment: "test", releaseId: "test-release", audience: "test-audience" }),
      fetch: async (input, init) => {
        const path = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).pathname;
        if (path === "/internal/v1/transcription/finalize/claim") {
          return Response.json({
            assignments: [
              {
                job_id: "job-1",
                transcript_id: "transcript-1",
                episode_id: "episode-1",
                attempt: 2,
                lease_token: "lease",
                lease_expires_at: expiresAt,
                chunks: [
                  {
                    chunk_id: "chunk-1",
                    input_url: "https://objects.example.test/chunk?X-Amz-Expires=600",
                    input_url_expires_at: expiresAt,
                    input_content_type: "application/json",
                    input_size_bytes: body.length,
                    input_sha256: createHash("sha256").update(body).digest("hex"),
                    episode_start_ms: 0,
                    episode_end_ms: 1_000,
                  },
                ],
                output_put_url: "https://objects.example.test/output?X-Amz-Expires=600",
                output_put_url_expires_at: expiresAt,
                output_content_type: "application/json",
              },
            ],
          });
        }
        if (path === "/internal/v1/transcription/jobs/heartbeat") return new Response(null, { status: 204 });
        if (path === "/internal/v1/transcription/finalize/retry") {
          if (typeof init?.body !== "string") throw new Error("retry body must be JSON");
          retryBodies.push(init.body);
          return new Response(null, { status: 204 });
        }
        throw new Error(`unexpected control request ${path}`);
      },
    });
    const result = await runFinalizeDispatcher(
      {},
      { getRemainingTimeInMillis: () => 30_000 },
      {
        config,
        control,
        fetch: async () => {
          if (failure === "download") throw new TypeError("request failed");
          return new Response(body, { headers: { "content-type": "application/json" } });
        },
        logger: {
          info: () => undefined,
          warn: (event) => {
            warnings.push(event);
          },
        },
      },
    );

    expect(result).toEqual({ claimed: 1, completed: 0, failed: 1 });
    expect(retryBodies).toHaveLength(1);
    expect(JSON.parse(retryBodies[0] ?? "")).toEqual({ job_id: "job-1", attempt: 2, lease_token: "lease", error_code: errorCode, terminal });
    expect(warnings).not.toContain("finalize_retry_report_failed");
  });

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
