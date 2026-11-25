import { ConfigError } from "./errors.js";
import type { DispatcherSecrets, SecretParameterNames } from "./secrets.js";
import type { ProviderPolicy } from "./provider-types.js";
import type { ReleaseConfig } from "./types.js";

export function required(value: string | undefined, key: string): string {
  if (!value) throw new ConfigError(`missing required configuration: ${key}`);
  return value;
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  return required(env[key], key);
}

function integer(env: NodeJS.ProcessEnv, key: string, min: number, max: number): number {
  const value = Number(requiredEnv(env, key));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`invalid bounded integer configuration: ${key}`);
  }
  return value;
}

function boolean(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = requiredEnv(env, key);
  if (value !== "true" && value !== "false") throw new ConfigError(`invalid boolean configuration: ${key}`);
  return value === "true";
}

function httpsUrl(value: string, key: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(`invalid URL configuration: ${key}`);
  }
  if (url.protocol !== "https:") throw new ConfigError(`configuration must use HTTPS: ${key}`);
  return url.toString().replace(/\/$/, "");
}

function policyFromEnv(env: NodeJS.ProcessEnv): ProviderPolicy {
  return {
    timeoutMs: integer(env, "TRANSCRIPTION_PROVIDER_TIMEOUT_MS", 100, 120_000),
    maxAudioBytes: integer(env, "TRANSCRIPTION_MAX_AUDIO_BYTES", 1, 50 * 1024 * 1024),
    maxAudioSeconds: integer(env, "TRANSCRIPTION_MAX_AUDIO_SECONDS", 1, 900),
    maxResponseBytes: integer(env, "TRANSCRIPTION_MAX_RESPONSE_BYTES", 1, 25 * 1024 * 1024),
    maxTextChars: integer(env, "TRANSCRIPTION_MAX_TEXT_CHARS", 1, 2_000_000),
    maxSegments: integer(env, "TRANSCRIPTION_MAX_SEGMENTS", 1, 100_000),
    maxWords: integer(env, "TRANSCRIPTION_MAX_WORDS", 1, 500_000),
    maxRetries: integer(env, "TRANSCRIPTION_MAX_RETRIES", 0, 5),
    retryBaseDelayMs: integer(env, "TRANSCRIPTION_RETRY_BASE_DELAY_MS", 1, 30_000),
    retryMaxDelayMs: integer(env, "TRANSCRIPTION_RETRY_MAX_DELAY_MS", 1, 120_000),
    circuitFailureThreshold: integer(env, "TRANSCRIPTION_CIRCUIT_FAILURE_THRESHOLD", 1, 100),
    circuitCooldownMs: integer(env, "TRANSCRIPTION_CIRCUIT_COOLDOWN_MS", 1_000, 3_600_000),
  };
}

/** The two SSM parameters used by the running dispatcher. */
export function secretParameterNames(env: NodeJS.ProcessEnv): SecretParameterNames {
  return {
    openRouterToken: requiredEnv(env, "OPENROUTER_TOKEN_PARAMETER_ARN"),
    workloadAuth: requiredEnv(env, "CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN"),
  };
}

/** Reads only the variables named in this file (`env` defaults to `process.env` so tests can pass their own). */
export function loadReleaseConfig(env: NodeJS.ProcessEnv = process.env, secrets?: DispatcherSecrets): ReleaseConfig {
  if (!secrets) throw new ConfigError("provider secrets must be resolved from SSM");
  const config: ReleaseConfig = {
    openRouterToken: requiredSecret(secrets.openRouterToken, "OpenRouter"),
    environment: requiredEnv(env, "CHALK_ENVIRONMENT"),
    releaseId: requiredEnv(env, "CHALK_RELEASE_ID"),
    controlApiAudience: requiredEnv(env, "CONTROL_API_AUDIENCE"),
    controlApiBaseUrl: httpsUrl(requiredEnv(env, "CONTROL_API_BASE_URL"), "CONTROL_API_BASE_URL"),
    maxBatch: integer(env, "TRANSCRIPTION_MAX_BATCH", 3, 50),
    concurrency: integer(env, "TRANSCRIPTION_CONCURRENCY", 3, 50),
    timeoutReserveMs: integer(env, "TRANSCRIPTION_TIMEOUT_RESERVE_MS", 60_000, 900_000),
    privacyGateAccepted: boolean(env, "TRANSCRIPTION_PRIVACY_GATE_ACCEPTED"),
    provider: policyFromEnv(env),
  };
  if (config.environment === "nightly" && (config.controlApiBaseUrl !== "https://nightly-api.chalkmeet.com" || config.controlApiAudience !== "chalk-nightly-control-api")) {
    throw new ConfigError("nightly requires its own control API URL and audience");
  }
  if (!config.privacyGateAccepted) throw new ConfigError("transcription privacy gate is not accepted");
  return config;
}

function requiredSecret(value: string | undefined, provider: string): string {
  if (!value) throw new ConfigError(`${provider} secret was not resolved from SSM`);
  return value;
}
