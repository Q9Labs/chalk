import { describe, expect, it, vi } from "vitest";
import { runDispatcher } from "../src/dispatcher.js";
import { ControlApiError } from "../src/errors.js";
import { validateCleanupAssignment } from "../src/urls.js";
import type { CleanupAssignment, ControlApi, ReleaseConfig } from "../src/types.js";

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

const assignment: CleanupAssignment = {
  jobId: "job",
  attempt: 1,
  leaseToken: "lease",
  leaseExpiresAt: new Date(Date.now() + 300_000).toISOString(),
  deleteUrl: "https://r2.example/delete?X-Amz-Expires=900",
  deleteUrlExpiresAt: new Date(Date.now() + 300_000).toISOString(),
};

function control(overrides: Partial<ControlApi> = {}): ControlApi {
  return {
    claim: vi.fn(),
    heartbeat: vi.fn(),
    retry: vi.fn(),
    complete: vi.fn(),
    claimCleanup: vi.fn(async () => ({ assignments: [assignment] })),
    completeCleanup: vi.fn(async () => undefined),
    retryCleanup: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("transcription cleanup lifecycle", () => {
  it("validates short-lived DELETE authority without accepting an object key", () => {
    expect(validateCleanupAssignment({ job_id: "job", attempt: 1, lease_token: "lease", lease_expires_at: assignment.leaseExpiresAt, delete_url: assignment.deleteUrl, delete_url_expires_at: assignment.deleteUrlExpiresAt })).toMatchObject({ jobId: "job", deleteUrl: assignment.deleteUrl });
    expect(() => validateCleanupAssignment({ ...assignment, deleteUrl: "http://r2.example/delete?X-Amz-Expires=900" })).toThrow();
  });

  it("deletes through the assignment URL, treats 404 as absent, and completes fenced work", async () => {
    const completeCleanup = vi.fn(async () => undefined);
    const deleteFetch = vi.fn(async () => new Response(null, { status: 404 }));
    const result = await runDispatcher({ source: "cleanup", journeyId: "journey" }, { getRemainingTimeInMillis: () => 120_000 }, { config, control: control({ completeCleanup }), fallback: { name: "cloudflare", transcribe: vi.fn() }, fetch: deleteFetch });
    expect(result).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(deleteFetch).toHaveBeenCalledWith(assignment.deleteUrl, { method: "DELETE" });
    expect(completeCleanup).toHaveBeenCalledWith(expect.objectContaining({ assignment, context: expect.objectContaining({ journeyId: "journey" }) }));
  });

  it("reports retryable DELETE failures and does not retry a late duplicate completion", async () => {
    const retryCleanup = vi.fn(async () => undefined);
    const failed = await runDispatcher({ source: "cleanup" }, { getRemainingTimeInMillis: () => 120_000 }, { config, control: control({ retryCleanup }), fallback: { name: "cloudflare", transcribe: vi.fn() }, fetch: vi.fn(async () => new Response(null, { status: 503 })) });
    expect(failed).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    expect(retryCleanup).toHaveBeenCalledWith(expect.objectContaining({ errorCode: "cleanup_delete_retryable", terminal: false }));

    const duplicateRetry = vi.fn(async () => undefined);
    const duplicate = await runDispatcher(
      { source: "cleanup" },
      { getRemainingTimeInMillis: () => 120_000 },
      {
        config,
        control: control({
          completeCleanup: vi.fn(async () => {
            throw new ControlApiError("late", 409);
          }),
          retryCleanup: duplicateRetry,
        }),
        fallback: { name: "cloudflare", transcribe: vi.fn() },
        fetch: vi.fn(async () => new Response(null, { status: 204 })),
      },
    );
    expect(duplicate).toMatchObject({ claimed: 1, completed: 0, failed: 1 });
    expect(duplicateRetry).not.toHaveBeenCalled();
  });

  it("does not claim cleanup work inside the timeout reserve", async () => {
    const claimCleanup = vi.fn(async () => ({ assignments: [] }));
    const result = await runDispatcher({ source: "cleanup" }, { getRemainingTimeInMillis: () => 60_000 }, { config, control: control({ claimCleanup }), fallback: { name: "cloudflare", transcribe: vi.fn() }, fetch: vi.fn() });
    expect(result).toEqual({ claimed: 0, completed: 0, failed: 0 });
    expect(claimCleanup).not.toHaveBeenCalled();
  });
});
