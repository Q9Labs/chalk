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

const env = {
  CHALK_ENVIRONMENT: "test",
  CHALK_RELEASE_ID: "release-1",
  CONTROL_API_AUDIENCE: "audience",
  CONTROL_API_BASE_URL: "https://control.example.test/",
  TRANSCRIPTION_MAX_BATCH: "3",
  TRANSCRIPTION_CONCURRENCY: "3",
  TRANSCRIPTION_TIMEOUT_RESERVE_MS: "60000",
  TRANSCRIPTION_PRIVACY_GATE_ACCEPTED: "true",
  ...policyEnv,
};

const secrets = { workloadAuth: "w", openRouterToken: "o" };

describe("loadReleaseConfig", () => {
  it("requires OpenRouter and trims the control API URL", () => {
    const config = loadReleaseConfig(env, secrets);
    expect(config).toMatchObject({ environment: "test", controlApiBaseUrl: "https://control.example.test", maxBatch: 3, openRouterToken: "o" });
    expect(config.provider.maxRetries).toBe(2);
  });

  it.each([
    ["secrets that were not resolved", env, undefined, "provider secrets must be resolved from SSM"],
    ["a privacy gate that is not accepted", { ...env, TRANSCRIPTION_PRIVACY_GATE_ACCEPTED: "false" }, secrets, "privacy gate is not accepted"],
    ["a plain HTTP control API", { ...env, CONTROL_API_BASE_URL: "http://control.example.test" }, secrets, "must use HTTPS"],
    ["a batch below the floor", { ...env, TRANSCRIPTION_MAX_BATCH: "2" }, secrets, "TRANSCRIPTION_MAX_BATCH"],
    ["a timeout reserve below the floor", { ...env, TRANSCRIPTION_TIMEOUT_RESERVE_MS: "1000" }, secrets, "TRANSCRIPTION_TIMEOUT_RESERVE_MS"],
    ["a nightly release on another API", { ...env, CHALK_ENVIRONMENT: "nightly" }, secrets, "nightly requires its own control API URL and audience"],
    ["an empty OpenRouter token", env, { ...secrets, openRouterToken: "" }, "OpenRouter secret was not resolved"],
  ])("rejects %s", (_label, environment, resolved, message) => {
    expect(() => loadReleaseConfig(environment, resolved)).toThrow(message);
  });
});
