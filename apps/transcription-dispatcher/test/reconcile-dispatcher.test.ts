import { describe, expect, it } from "vitest";

import { RecorderControlApiClient } from "../src/control-api.js";
import { runDispatcher, type DispatcherDependencies } from "../src/dispatcher.js";
import type { ReleaseConfig } from "../src/types.js";
import { HmacWorkloadSigner } from "../src/workload-auth.js";

const config: ReleaseConfig = {
  environment: "test",
  releaseId: "test-release",
  controlApiAudience: "test-audience",
  controlApiBaseUrl: "https://control.example",
  maxBatch: 3,
  concurrency: 3,
  timeoutReserveMs: 1_000,
  privacyGateAccepted: true,
  deepInfra: { enabled: false, model: "openai/whisper-large-v3-turbo" },
  cloudflare: {
    token: "test-token",
    accountId: "test-account",
    modelSlug: "@cf/openai/whisper-large-v3-turbo",
    adapterContractVersion: "test-contract",
    corpusDigest: "test-corpus",
  },
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

describe("scheduled reconciliation", () => {
  it("claims every queue through a stateful control API client", async () => {
    const paths: string[] = [];
    const controlFetch = (async (input: string | URL | Request) => {
      paths.push(new URL(typeof input === "string" || input instanceof URL ? input : input.url).pathname);
      return Response.json({ assignments: [] });
    }) as typeof fetch;
    const control = new RecorderControlApiClient({
      baseUrl: config.controlApiBaseUrl,
      signer: new HmacWorkloadSigner({ secret: "test-secret", environment: config.environment, releaseId: config.releaseId, audience: config.controlApiAudience }),
      fetch: controlFetch,
    });
    const dependencies: DispatcherDependencies = {
      config,
      control,
      fallback: {
        name: "cloudflare",
        transcribe: async () => {
          throw new Error("no assignment should reach the provider");
        },
      },
      fetch: controlFetch,
    };

    const result = await runDispatcher(
      { source: "eventbridge.scheduler", kind: "transcription-reconcile" },
      { getRemainingTimeInMillis: () => 30_000 },
      dependencies,
    );

    expect(result).toEqual({ claimed: 0, completed: 0, failed: 0 });
    expect(paths.sort()).toEqual([
      "/internal/v1/transcription/cleanup/claim",
      "/internal/v1/transcription/finalize/claim",
      "/internal/v1/transcription/jobs/claim",
    ]);

    paths.length = 0;
    await expect(
      runDispatcher(
        { source: "wake", journeyId: "" },
        { getRemainingTimeInMillis: () => 30_000 },
        dependencies,
      ),
    ).resolves.toEqual({ claimed: 0, completed: 0, failed: 0 });
    expect(paths).toEqual(["/internal/v1/transcription/jobs/claim"]);
  });
});
