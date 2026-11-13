import { describe, expect, it } from "vitest";
import { loadReleaseConfig } from "../src/config.js";

const policyEnv = {
  TRANSCRIPTION_PROVIDER_TIMEOUT_MS: "10000",
  TRANSCRIPTION_MAX_AUDIO_BYTES: "1024",
  TRANSCRIPTION_MAX_AUDIO_SECONDS: "900",
  TRANSCRIPTION_MAX_RESPONSE_BYTES: "1024",
  TRANSCRIPTION_MAX_TEXT_CHARS: "1024",
  TRANSCRIPTION_MAX_SEGMENTS: "100",
  TRANSCRIPTION_MAX_WORDS: "100",
  TRANSCRIPTION_MAX_RETRIES: "2",
  TRANSCRIPTION_RETRY_BASE_DELAY_MS: "10",
  TRANSCRIPTION_RETRY_MAX_DELAY_MS: "100",
  TRANSCRIPTION_CIRCUIT_FAILURE_THRESHOLD: "5",
  TRANSCRIPTION_CIRCUIT_COOLDOWN_MS: "1000",
};

const digest = "a".repeat(32);

const env = {
  CHALK_ENVIRONMENT: "test",
  CHALK_RELEASE_ID: "release-1",
  CONTROL_API_AUDIENCE: "audience",
  CONTROL_API_BASE_URL: "https://control.example.test/",
  TRANSCRIPTION_MAX_BATCH: "3",
  TRANSCRIPTION_CONCURRENCY: "3",
  TRANSCRIPTION_TIMEOUT_RESERVE_MS: "60000",
  TRANSCRIPTION_PRIVACY_GATE_ACCEPTED: "true",
  DEEPINFRA_ENABLED: "true",
  DEEPINFRA_ADAPTER_CONTRACT_VERSION: "deepinfra-native-whisper-turbo.v1",
  DEEPINFRA_CORPUS_DIGEST: digest,
  CLOUDFLARE_AI_ENABLED: "false",
  ...policyEnv,
};

const secrets = { workloadAuth: "w", deepInfraToken: "d", cloudflareAiToken: "c", openRouterToken: "o" };

describe("loadReleaseConfig", () => {
  it("reads a DeepInfra release and trims the control API URL", () => {
    const config = loadReleaseConfig(env, secrets);
    expect(config).toMatchObject({ environment: "test", controlApiBaseUrl: "https://control.example.test", maxBatch: 3, deepInfra: { enabled: true, token: "d" }, cloudflare: { enabled: false } });
    expect(config.provider.maxRetries).toBe(2);
  });

  it("reads a Cloudflare-only release", () => {
    const config = loadReleaseConfig({ ...env, DEEPINFRA_ENABLED: "false", CLOUDFLARE_AI_ENABLED: "true", CLOUDFLARE_ACCOUNT_ID: "acct", CLOUDFLARE_MODEL_SLUG: "@cf/openai/whisper-large-v3-turbo", CLOUDFLARE_ADAPTER_CONTRACT_VERSION: "cf.v1", CLOUDFLARE_CORPUS_DIGEST: digest }, secrets);
    expect(config.cloudflare).toMatchObject({ enabled: true, token: "c", accountId: "acct" });
  });

  it("selects the MAI code-switching provider with its token", () => {
    expect(loadReleaseConfig({ ...env, CODESWITCH_PROVIDER: "mai" }, secrets)).toMatchObject({ codeswitchProvider: "mai", openRouterToken: "o" });
  });

  it.each([
    ["secrets that were not resolved", { ...env }, undefined, "provider secrets must be resolved from SSM"],
    ["a privacy gate that is not accepted", { ...env, TRANSCRIPTION_PRIVACY_GATE_ACCEPTED: "false" }, secrets, "privacy gate is not accepted"],
    ["no provider", { ...env, DEEPINFRA_ENABLED: "false" }, secrets, "at least one transcription provider must be enabled"],
    ["a plain HTTP control API", { ...env, CONTROL_API_BASE_URL: "http://control.example.test" }, secrets, "must use HTTPS"],
    ["a batch below the floor", { ...env, TRANSCRIPTION_MAX_BATCH: "2" }, secrets, "TRANSCRIPTION_MAX_BATCH"],
    ["a timeout reserve below the floor", { ...env, TRANSCRIPTION_TIMEOUT_RESERVE_MS: "1000" }, secrets, "TRANSCRIPTION_TIMEOUT_RESERVE_MS"],
    ["a nightly release on another API", { ...env, CHALK_ENVIRONMENT: "nightly" }, secrets, "nightly requires its own control API URL and audience"],
    ["an unsupported DeepInfra adapter", { ...env, DEEPINFRA_ADAPTER_CONTRACT_VERSION: "other" }, secrets, "DeepInfra adapter contract is not supported"],
    ["a malformed DeepInfra corpus digest", { ...env, DEEPINFRA_CORPUS_DIGEST: "xyz" }, secrets, "DeepInfra corpus digest is required"],
    ["a DeepInfra token that SSM did not return", { ...env }, { workloadAuth: "w" }, "DeepInfra secret was not resolved"],
    [
      "a Cloudflare adapter version with bad characters",
      { ...env, DEEPINFRA_ENABLED: "false", CLOUDFLARE_AI_ENABLED: "true", CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_MODEL_SLUG: "@cf/openai/whisper-large-v3-turbo", CLOUDFLARE_ADAPTER_CONTRACT_VERSION: "bad version", CLOUDFLARE_CORPUS_DIGEST: digest },
      secrets,
      "Cloudflare adapter contract version is required",
    ],
    [
      "a malformed Cloudflare corpus digest",
      { ...env, DEEPINFRA_ENABLED: "false", CLOUDFLARE_AI_ENABLED: "true", CLOUDFLARE_ACCOUNT_ID: "a", CLOUDFLARE_MODEL_SLUG: "@cf/openai/whisper-large-v3-turbo", CLOUDFLARE_ADAPTER_CONTRACT_VERSION: "cf.v1", CLOUDFLARE_CORPUS_DIGEST: "xyz" },
      secrets,
      "Cloudflare corpus digest is required",
    ],
    ["MAI selected without an OpenRouter token", { ...env, CODESWITCH_PROVIDER: "mai" }, { workloadAuth: "w", deepInfraToken: "d" }, "OpenRouter secret was not resolved"],
  ])("rejects %s", (_label, environment, resolved, message) => {
    expect(() => loadReleaseConfig(environment, resolved)).toThrow(message);
  });
});
