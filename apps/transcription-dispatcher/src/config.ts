import { ConfigError } from "./errors.js";
import { CLOUDFLARE_MODEL, DEEPINFRA_MODEL } from "./models.js";
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

function validateReleaseConfig(config: ReleaseConfig): ReleaseConfig {
  if (config.codeswitchProvider === "mai" && !config.openRouterToken) throw new ConfigError("OpenRouter token is required for MAI");
  if (config.environment === "nightly" && (config.controlApiBaseUrl !== "https://nightly-api.chalkmeet.com" || config.controlApiAudience !== "chalk-nightly-control-api")) {
    throw new ConfigError("nightly requires its own control API URL and audience");
  }
  if (!config.privacyGateAccepted) throw new ConfigError("transcription privacy gate is not accepted");
  if (!config.controlApiBaseUrl.startsWith("https://")) throw new ConfigError("control API must use HTTPS");
  if (config.maxBatch < 3 || config.maxBatch > 50) throw new ConfigError("max batch must be between 3 and 50 so reconciliation cannot starve a durable queue");
  if (config.concurrency < 3 || config.concurrency > 50) throw new ConfigError("concurrency must be between 3 and 50 so reconciliation can service every durable queue");
  if (config.timeoutReserveMs < 60_000) throw new ConfigError("timeout reserve must be at least 60 seconds");
  if (!config.deepInfra.enabled && !config.cloudflare.enabled) throw new ConfigError("at least one transcription provider must be enabled");
  if (config.cloudflare.enabled) {
    if (!config.cloudflare.adapterContractVersion || !/^[A-Za-z0-9._-]+$/.test(config.cloudflare.adapterContractVersion)) {
      throw new ConfigError("Cloudflare adapter contract version is required");
    }
    if (!/^[a-f0-9]{32,128}$/i.test(config.cloudflare.corpusDigest)) throw new ConfigError("Cloudflare corpus digest is required");
  }
  if (config.deepInfra.enabled) {
    if (!config.deepInfra.token) throw new ConfigError("DeepInfra token is required when enabled");
    if (config.deepInfra.adapterContractVersion !== "deepinfra-native-whisper-turbo.v1") throw new ConfigError("DeepInfra adapter contract is not supported");
    if (!config.deepInfra.corpusDigest || !/^[a-f0-9]{32,128}$/i.test(config.deepInfra.corpusDigest)) throw new ConfigError("DeepInfra corpus digest is required when enabled");
  }
  return config;
}

function codeswitchProvider(env: NodeJS.ProcessEnv): "mai" | undefined {
  const selected = env.CODESWITCH_PROVIDER;
  if (selected && selected !== "mai") throw new ConfigError("code-switching provider is not release-qualified");
  return selected === "mai" ? "mai" : undefined;
}

/** The SSM parameters this release needs, chosen by the same provider switches `loadReleaseConfig` reads. */
export function secretParameterNames(env: NodeJS.ProcessEnv): SecretParameterNames {
  return {
    ...(codeswitchProvider(env) ? { openRouterToken: requiredEnv(env, "OPENROUTER_TOKEN_PARAMETER_ARN") } : {}),
    ...(boolean(env, "DEEPINFRA_ENABLED") ? { deepInfraToken: requiredEnv(env, "DEEPINFRA_TOKEN_PARAMETER_ARN") } : {}),
    ...(boolean(env, "CLOUDFLARE_AI_ENABLED") ? { cloudflareAiToken: requiredEnv(env, "CLOUDFLARE_AI_TOKEN_PARAMETER_ARN") } : {}),
    workloadAuth: requiredEnv(env, "CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN"),
  };
}

export function loadReleaseConfig(env: NodeJS.ProcessEnv = process.env, secrets?: DispatcherSecrets): ReleaseConfig {
  const deepInfraEnabled = boolean(env, "DEEPINFRA_ENABLED");
  const cloudflareEnabled = boolean(env, "CLOUDFLARE_AI_ENABLED");
  if (!secrets) throw new ConfigError("provider secrets must be resolved from SSM");
  const selected = codeswitchProvider(env);
  const config: ReleaseConfig = {
    ...(selected ? { codeswitchProvider: "mai", openRouterToken: requiredSecret(secrets.openRouterToken, "OpenRouter") } : {}),
    environment: requiredEnv(env, "CHALK_ENVIRONMENT"),
    releaseId: requiredEnv(env, "CHALK_RELEASE_ID"),
    controlApiAudience: requiredEnv(env, "CONTROL_API_AUDIENCE"),
    controlApiBaseUrl: httpsUrl(requiredEnv(env, "CONTROL_API_BASE_URL"), "CONTROL_API_BASE_URL"),
    maxBatch: integer(env, "TRANSCRIPTION_MAX_BATCH", 3, 50),
    concurrency: integer(env, "TRANSCRIPTION_CONCURRENCY", 3, 50),
    timeoutReserveMs: integer(env, "TRANSCRIPTION_TIMEOUT_RESERVE_MS", 60_000, 900_000),
    privacyGateAccepted: boolean(env, "TRANSCRIPTION_PRIVACY_GATE_ACCEPTED"),
    deepInfra: {
      enabled: deepInfraEnabled,
      ...(deepInfraEnabled ? { token: requiredSecret(secrets.deepInfraToken, "DeepInfra") } : {}),
      ...(deepInfraEnabled ? { adapterContractVersion: requiredEnv(env, "DEEPINFRA_ADAPTER_CONTRACT_VERSION"), corpusDigest: requiredEnv(env, "DEEPINFRA_CORPUS_DIGEST") } : {}),
      ...(deepInfraEnabled && env.DEEPINFRA_EXECUTION_IDENTITY_PIN ? { executionIdentityPin: env.DEEPINFRA_EXECUTION_IDENTITY_PIN } : {}),
      ...(deepInfraEnabled && env.DEEPINFRA_MODEL_VERSION_PIN ? { modelVersionPin: env.DEEPINFRA_MODEL_VERSION_PIN } : {}),
      model: DEEPINFRA_MODEL,
    },
    cloudflare: cloudflareEnabled
      ? {
          enabled: true,
          token: requiredSecret(secrets.cloudflareAiToken, "Cloudflare"),
          accountId: requiredEnv(env, "CLOUDFLARE_ACCOUNT_ID"),
          modelSlug: cloudflareModel(env),
          adapterContractVersion: requiredEnv(env, "CLOUDFLARE_ADAPTER_CONTRACT_VERSION"),
          corpusDigest: requiredEnv(env, "CLOUDFLARE_CORPUS_DIGEST"),
        }
      : { enabled: false },
    provider: policyFromEnv(env),
  };
  return validateReleaseConfig(config);
}

function cloudflareModel(env: NodeJS.ProcessEnv): typeof CLOUDFLARE_MODEL {
  const model = requiredEnv(env, "CLOUDFLARE_MODEL_SLUG");
  if (model !== CLOUDFLARE_MODEL) throw new ConfigError("Cloudflare model slug is not release-qualified");
  return model;
}

function requiredSecret(value: string | undefined, provider: string): string {
  if (!value) throw new ConfigError(`${provider} secret was not resolved from SSM`);
  return value;
}
