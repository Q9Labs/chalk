import { ConfigError } from "./errors.js";
import type { DispatcherSecrets } from "./secrets.js";
import type { ProviderPolicy, ReleaseConfig } from "./types.js";

const CF_MODEL = "@cf/openai/whisper-large-v3-turbo" as const;
const DI_MODEL = "openai/whisper-large-v3-turbo" as const;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new ConfigError(`missing required configuration: ${key}`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, key: string, min: number, max: number): number {
  const value = Number(required(env, key));
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ConfigError(`invalid bounded integer configuration: ${key}`);
  }
  return value;
}

function boolean(env: NodeJS.ProcessEnv, key: string): boolean {
  const value = required(env, key);
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

export function validateReleaseConfig(config: ReleaseConfig): ReleaseConfig {
  if (!config.privacyGateAccepted) throw new ConfigError("transcription privacy gate is not accepted");
  if (!config.controlApiBaseUrl.startsWith("https://")) throw new ConfigError("control API must use HTTPS");
  if (config.maxBatch < 3 || config.maxBatch > 50) throw new ConfigError("max batch must be between 3 and 50 so reconciliation cannot starve a durable queue");
  if (config.concurrency < 1 || config.concurrency > 50) throw new ConfigError("concurrency must be between 1 and 50");
  if (config.timeoutReserveMs < 60_000) throw new ConfigError("timeout reserve must be at least 60 seconds");
  if (config.cloudflare.modelSlug !== CF_MODEL) throw new ConfigError("Cloudflare model slug is not release-qualified");
  if (!config.cloudflare.adapterContractVersion || !/^[A-Za-z0-9._-]+$/.test(config.cloudflare.adapterContractVersion)) {
    throw new ConfigError("Cloudflare adapter contract version is required");
  }
  if (!/^[a-f0-9]{32,128}$/i.test(config.cloudflare.corpusDigest)) throw new ConfigError("Cloudflare corpus digest is required");
  if (config.deepInfra.enabled) {
    if (!config.deepInfra.token) throw new ConfigError("DeepInfra token is required when enabled");
    if (!config.deepInfra.executionIdentityPin) throw new ConfigError("DeepInfra execution identity pin is required when enabled");
    if (!config.deepInfra.modelVersionPin) throw new ConfigError("DeepInfra model version pin is required when enabled");
  }
  if (config.deepInfra.model !== DI_MODEL) throw new ConfigError("DeepInfra model is not release-qualified");
  return config;
}

export function loadReleaseConfig(env: NodeJS.ProcessEnv = process.env, secrets?: DispatcherSecrets): ReleaseConfig {
  const deepInfraEnabled = boolean(env, "DEEPINFRA_ENABLED");
  if (!secrets) throw new ConfigError("provider secrets must be resolved from SSM");
  const config: ReleaseConfig = {
    environment: required(env, "CHALK_ENVIRONMENT"),
    releaseId: required(env, "CHALK_RELEASE_ID"),
    controlApiAudience: required(env, "CONTROL_API_AUDIENCE"),
    controlApiBaseUrl: httpsUrl(required(env, "CONTROL_API_BASE_URL"), "CONTROL_API_BASE_URL"),
    maxBatch: integer(env, "TRANSCRIPTION_MAX_BATCH", 3, 50),
    concurrency: integer(env, "TRANSCRIPTION_CONCURRENCY", 1, 50),
    timeoutReserveMs: integer(env, "TRANSCRIPTION_TIMEOUT_RESERVE_MS", 60_000, 900_000),
    privacyGateAccepted: boolean(env, "TRANSCRIPTION_PRIVACY_GATE_ACCEPTED"),
    deepInfra: {
      enabled: deepInfraEnabled,
      ...(deepInfraEnabled ? { token: requiredSecret(secrets.deepInfraToken, "DeepInfra") } : {}),
      ...(deepInfraEnabled ? { executionIdentityPin: required(env, "DEEPINFRA_EXECUTION_IDENTITY_PIN") } : {}),
      ...(deepInfraEnabled ? { modelVersionPin: required(env, "DEEPINFRA_MODEL_VERSION_PIN") } : {}),
      model: DI_MODEL,
    },
    cloudflare: {
      token: requiredSecret(secrets.cloudflareAiToken, "Cloudflare"),
      accountId: required(env, "CLOUDFLARE_ACCOUNT_ID"),
      modelSlug: required(env, "CLOUDFLARE_MODEL_SLUG") as ReleaseConfig["cloudflare"]["modelSlug"],
      adapterContractVersion: required(env, "CLOUDFLARE_ADAPTER_CONTRACT_VERSION"),
      corpusDigest: required(env, "CLOUDFLARE_CORPUS_DIGEST"),
    },
    provider: policyFromEnv(env),
  };
  return validateReleaseConfig(config);
}

function requiredSecret(value: string | undefined, provider: string): string {
  if (!value) throw new ConfigError(`${provider} secret was not resolved from SSM`);
  return value;
}
