import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadDispatcherSecrets } from "../src/secrets.js";
import { loadReleaseConfig } from "../src/config.js";
import { runNoContentCanary } from "../src/canary.js";
import { conditionalPutJson, fetchAudioChunk } from "../src/storage.js";
import { MAX_FINALIZER_CHUNKS } from "../src/finalizer-limits.js";
import { validateFinalizeAssignment } from "../src/urls.js";

const future = new Date(Date.now() + 300_000).toISOString();
const env: NodeJS.ProcessEnv = {
  CHALK_ENVIRONMENT: "test",
  CHALK_RELEASE_ID: "release-1",
  CONTROL_API_AUDIENCE: "chalk-control-api",
  CONTROL_API_BASE_URL: "https://control.example",
  CONTROL_API_WORKLOAD_AUTH: "workload",
  DEEPINFRA_ENABLED: "false",
  TRANSCRIPTION_PRIVACY_GATE_ACCEPTED: "true",
  CLOUDFLARE_AI_TOKEN: "cf",
  CLOUDFLARE_ACCOUNT_ID: "account",
  CLOUDFLARE_MODEL_SLUG: "@cf/openai/whisper-large-v3-turbo",
  CLOUDFLARE_ADAPTER_CONTRACT_VERSION: "cf-contract-1",
  CLOUDFLARE_CORPUS_DIGEST: "a".repeat(64),
  TRANSCRIPTION_MAX_BATCH: "10",
  TRANSCRIPTION_CONCURRENCY: "10",
  TRANSCRIPTION_TIMEOUT_RESERVE_MS: "60000",
  TRANSCRIPTION_PROVIDER_TIMEOUT_MS: "1000",
  TRANSCRIPTION_MAX_AUDIO_BYTES: "10000",
  TRANSCRIPTION_MAX_AUDIO_SECONDS: "60",
  TRANSCRIPTION_MAX_RESPONSE_BYTES: "10000",
  TRANSCRIPTION_MAX_TEXT_CHARS: "1000",
  TRANSCRIPTION_MAX_SEGMENTS: "10",
  TRANSCRIPTION_MAX_WORDS: "100",
  TRANSCRIPTION_MAX_RETRIES: "1",
  TRANSCRIPTION_RETRY_BASE_DELAY_MS: "1",
  TRANSCRIPTION_RETRY_MAX_DELAY_MS: "10",
  TRANSCRIPTION_CIRCUIT_FAILURE_THRESHOLD: "2",
  TRANSCRIPTION_CIRCUIT_COOLDOWN_MS: "1000",
};

describe("release, storage, and canary gates", () => {
  it("fails closed when the privacy gate is false", () => {
    expect(() => loadReleaseConfig({ ...env, TRANSCRIPTION_PRIVACY_GATE_ACCEPTED: "false" })).toThrow();
  });

  it("requires enough concurrency for every reconciliation queue", () => {
    expect(() => loadReleaseConfig({ ...env, TRANSCRIPTION_CONCURRENCY: "2" }, { cloudflareAiToken: "cf", workloadAuth: "auth" })).toThrow(/invalid bounded integer configuration/);
  });

  it("loads only explicitly named decrypted SSM values", async () => {
    const send = vi.fn(async (command: { input: { Names: string[]; WithDecryption: true } }) => ({ Parameters: command.input.Names.map((Name) => ({ Name, Value: `${Name}-secret` })) }));
    const values = await loadDispatcherSecrets({ send }, { cloudflareAiToken: "/chalk/test/cf", workloadAuth: "/chalk/test/auth", deepInfraToken: "/chalk/test/di" });
    expect(values.cloudflareAiToken).toBe("/chalk/test/cf-secret");
    expect(send).toHaveBeenCalledWith({ input: { Names: ["/chalk/test/cf", "/chalk/test/auth", "/chalk/test/di"], WithDecryption: true } });
  });

  it("rejects malformed audio and conditional duplicate writes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const get = vi.fn(async () => new Response(bytes, { headers: { "content-type": "audio/mpeg", "content-length": "3" } }));
    await expect(fetchAudioChunk({ fetch: get, url: "https://r2.example/chunk", expectedContentType: "audio/mpeg", expectedSizeBytes: 3, expectedSha256: digest, maxBytes: 10 })).resolves.toMatchObject({ sha256: digest });
    const put = vi.fn(async () => new Response(null, { status: 412 }));
    await expect(
      conditionalPutJson({
        fetch: put,
        url: "https://r2.example/result",
        body: new Uint8Array([1]),
        checksumSha256: createHash("sha256")
          .update(new Uint8Array([1]))
          .digest("hex"),
      }),
    ).resolves.toBe("already_exists");
  });

  it("reports schema and identity drift as disable-worthy without content", async () => {
    const expected = { provider: "cloudflare" as const, model: "@cf/openai/whisper-large-v3-turbo", versionContract: "cf-1" };
    await expect(runNoContentCanary({ expected, probe: async () => ({ schemaVersion: "changed", ...expected }) })).resolves.toMatchObject({ ok: false, disablePrimary: true, reason: "schema_drift" });
    await expect(runNoContentCanary({ expected, probe: async () => ({ schemaVersion: "transcript.v1", ...expected, versionContract: "cf-2" }) })).resolves.toMatchObject({ ok: false, disablePrimary: true, reason: "identity_drift" });
  });

  it("bounds finalizer assignments at the API contract limit", () => {
    const chunk = {
      chunk_id: "chunk",
      input_url: "https://r2.example/chunk?X-Amz-Expires=900",
      input_url_expires_at: future,
      input_content_type: "application/json",
      input_size_bytes: 1,
      input_sha256: "a".repeat(64),
      meeting_start_ms: 0,
      meeting_end_ms: 1,
    };
    const assignment = {
      job_id: "job",
      transcript_id: "transcript",
      session_id: "session",
      attempt: 1,
      lease_token: "lease",
      lease_expires_at: future,
      chunks: Array.from({ length: MAX_FINALIZER_CHUNKS }, (_, index) => ({ ...chunk, chunk_id: `chunk-${index}` })),
      output_put_url: "https://r2.example/final?X-Amz-Expires=900",
      output_put_url_expires_at: future,
      output_content_type: "application/json",
    };
    expect(validateFinalizeAssignment(assignment).chunks).toHaveLength(MAX_FINALIZER_CHUNKS);
    expect(() => validateFinalizeAssignment({ ...assignment, chunks: [...assignment.chunks, { ...chunk, chunk_id: "too-many" }] })).toThrow(/chunks are invalid/);
  });
});
