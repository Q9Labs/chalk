import type { DispatcherInputs } from "./config.ts";

export const buildEnvironment = (input: DispatcherInputs): { [key: string]: string } => ({
  CHALK_ENVIRONMENT: String(input.environment_name),
  CHALK_RELEASE_ID: String(input.release_id),
  CHALK_RELEASE_MANIFEST_DIGEST: String(input.release_manifest_digest),
  CHALK_CONFIG_DIGEST: String(input.config_digest),
  CONTROL_API_BASE_URL: String(input.control_api_url),
  CONTROL_API_AUDIENCE: String(input.control_api_audience),
  TRANSCRIPTION_MAX_BATCH: String(input.max_batch),
  TRANSCRIPTION_CONCURRENCY: String(input.reserved_concurrency),
  TRANSCRIPTION_PRIVACY_GATE_ACCEPTED: String(input.privacy_gate_accepted),
  DEEPINFRA_ENABLED: String(input.deepinfra_enabled),
  CLOUDFLARE_AI_ENABLED: String(input.cloudflare_enabled),
  TRANSCRIPTION_PROVIDER_TIMEOUT_MS: String(input.provider_timeout_ms),
  TRANSCRIPTION_MAX_AUDIO_BYTES: String(input.max_audio_bytes),
  TRANSCRIPTION_MAX_AUDIO_SECONDS: String(input.max_audio_seconds),
  TRANSCRIPTION_MAX_RESPONSE_BYTES: String(input.max_response_bytes),
  TRANSCRIPTION_MAX_TEXT_CHARS: String(input.max_text_chars),
  TRANSCRIPTION_MAX_SEGMENTS: String(input.max_segments),
  TRANSCRIPTION_MAX_WORDS: String(input.max_words),
  TRANSCRIPTION_MAX_RETRIES: String(input.provider_max_retries),
  TRANSCRIPTION_RETRY_BASE_DELAY_MS: String(input.retry_base_delay_ms),
  TRANSCRIPTION_RETRY_MAX_DELAY_MS: String(input.retry_max_delay_ms),
  TRANSCRIPTION_CIRCUIT_FAILURE_THRESHOLD: String(input.circuit_failure_threshold),
  TRANSCRIPTION_CIRCUIT_COOLDOWN_MS: String(input.circuit_cooldown_ms),
  CHALK_TRANSCRIPTION_HANDLER: String(input.handler),
  CHALK_TRANSCRIPTION_WORK_BUDGET: String(input.work_budget_seconds),
  CHALK_COMPLETION_RESERVE_SECONDS: String(input.completion_reserve_seconds),
  CONTROL_API_WORKLOAD_AUTH_PARAMETER_ARN: String(input.api_workload_auth_parameter_arn),
  TRANSCRIPTION_TIMEOUT_RESERVE_MS: String(input.completion_reserve_seconds * 1000),
  ...(input.codeswitch_provider === "mai"
    ? {
        CODESWITCH_PROVIDER: String(input.codeswitch_provider),
        OPENROUTER_TOKEN_PARAMETER_ARN: String(input.openrouter_token_parameter_arn),
      }
    : {}),
  ...(input.deepinfra_enabled
    ? {
        DEEPINFRA_ADAPTER_CONTRACT_VERSION: String(input.deepinfra_adapter_contract_version),
        DEEPINFRA_CORPUS_DIGEST: String(input.deepinfra_corpus_digest),
        DEEPINFRA_TOKEN_PARAMETER_ARN: String(input.deepinfra_token_parameter_arn),
      }
    : {}),
  ...(input.cloudflare_enabled
    ? {
        CLOUDFLARE_ACCOUNT_ID: String(input.cloudflare_account_id),
        CLOUDFLARE_MODEL_SLUG: String(input.cloudflare_model_slug),
        CLOUDFLARE_ADAPTER_CONTRACT_VERSION: String(input.cloudflare_adapter_contract_version),
        CLOUDFLARE_CORPUS_DIGEST: String(input.cloudflare_corpus_digest),
        CLOUDFLARE_AI_TOKEN_PARAMETER_ARN: String(input.cloudflare_token_parameter_arn),
      }
    : {}),
  ...(input.deepinfra_enabled && input.deepinfra_model_version_pin !== "" ? { DEEPINFRA_MODEL_VERSION_PIN: input.deepinfra_model_version_pin } : {}),
  ...(input.deepinfra_enabled && input.deepinfra_execution_identity_pin !== "" ? { DEEPINFRA_EXECUTION_IDENTITY_PIN: input.deepinfra_execution_identity_pin } : {}),
});
