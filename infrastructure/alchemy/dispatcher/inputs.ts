import * as Schema from "effect/Schema";

const inputSchema = Schema.Struct({
  function_name: Schema.String,
  environment_name: Schema.String,
  release_id: Schema.String,
  release_manifest_digest: Schema.String,
  config_digest: Schema.String,
  artifact_s3_bucket: Schema.String,
  artifact_s3_key: Schema.String,
  artifact_s3_object_version: Schema.String,
  artifact_sha256: Schema.String,
  artifact_sha256_base64: Schema.String,
  handler: Schema.String,
  timeout_seconds: Schema.Number,
  work_budget_seconds: Schema.Number,
  completion_reserve_seconds: Schema.Number,
  reserved_concurrency: Schema.Number,
  memory_size: Schema.Number,
  ephemeral_storage_size: Schema.Number,
  control_api_url: Schema.String,
  control_api_audience: Schema.String,
  max_batch: Schema.Number,
  privacy_gate_accepted: Schema.Boolean,
  deepinfra_enabled: Schema.Boolean,
  deepinfra_execution_identity_pin: Schema.String,
  deepinfra_model_version_pin: Schema.String,
  deepinfra_adapter_contract_version: Schema.String,
  deepinfra_corpus_digest: Schema.String,
  cloudflare_enabled: Schema.Boolean,
  cloudflare_account_id: Schema.String,
  cloudflare_model_slug: Schema.String,
  cloudflare_adapter_contract_version: Schema.String,
  cloudflare_corpus_digest: Schema.String,
  provider_timeout_ms: Schema.Number,
  max_audio_bytes: Schema.Number,
  max_audio_seconds: Schema.Number,
  max_response_bytes: Schema.Number,
  max_text_chars: Schema.Number,
  max_segments: Schema.Number,
  max_words: Schema.Number,
  provider_max_retries: Schema.Number,
  retry_base_delay_ms: Schema.Number,
  retry_max_delay_ms: Schema.Number,
  circuit_failure_threshold: Schema.Number,
  circuit_cooldown_ms: Schema.Number,
  deepinfra_token_parameter_arn: Schema.String,
  cloudflare_token_parameter_arn: Schema.String,
  api_workload_auth_parameter_arn: Schema.String,
  ssm_kms_key_arns: Schema.Array(Schema.String),
  log_retention_days: Schema.Number,
  log_kms_key_arn: Schema.NullOr(Schema.String),
  failure_queue_kms_key_arn: Schema.NullOr(Schema.String),
  async_max_event_age_seconds: Schema.Number,
  async_maximum_retry_attempts: Schema.Number,
  scheduler_name: Schema.String,
  scheduler_group_name: Schema.String,
  scheduler_state: Schema.String,
  scheduler_input_json: Schema.String,
  scheduler_max_event_age_seconds: Schema.Number,
  scheduler_maximum_retry_attempts: Schema.Number,
  alarm_actions: Schema.Array(Schema.String),
  control_api_invoker_principal: Schema.NullOr(Schema.String),
  control_api_invoke_source_arn: Schema.NullOr(Schema.String),
  codeswitch_provider: Schema.String,
  openrouter_token_parameter_arn: Schema.String,
});
export type DispatcherInputs = typeof inputSchema.Type;
const partialSchema = Schema.Struct({
  function_name: Schema.optionalKey(Schema.String),
  environment_name: Schema.optionalKey(Schema.String),
  release_id: Schema.optionalKey(Schema.String),
  release_manifest_digest: Schema.optionalKey(Schema.String),
  config_digest: Schema.optionalKey(Schema.String),
  artifact_s3_bucket: Schema.optionalKey(Schema.String),
  artifact_s3_key: Schema.optionalKey(Schema.String),
  artifact_s3_object_version: Schema.optionalKey(Schema.String),
  artifact_sha256: Schema.optionalKey(Schema.String),
  artifact_sha256_base64: Schema.optionalKey(Schema.String),
  handler: Schema.optionalKey(Schema.String),
  timeout_seconds: Schema.optionalKey(Schema.Number),
  work_budget_seconds: Schema.optionalKey(Schema.Number),
  completion_reserve_seconds: Schema.optionalKey(Schema.Number),
  reserved_concurrency: Schema.optionalKey(Schema.Number),
  memory_size: Schema.optionalKey(Schema.Number),
  ephemeral_storage_size: Schema.optionalKey(Schema.Number),
  control_api_url: Schema.optionalKey(Schema.String),
  control_api_audience: Schema.optionalKey(Schema.String),
  max_batch: Schema.optionalKey(Schema.Number),
  privacy_gate_accepted: Schema.optionalKey(Schema.Boolean),
  deepinfra_enabled: Schema.optionalKey(Schema.Boolean),
  deepinfra_execution_identity_pin: Schema.optionalKey(Schema.String),
  deepinfra_model_version_pin: Schema.optionalKey(Schema.String),
  deepinfra_adapter_contract_version: Schema.optionalKey(Schema.String),
  deepinfra_corpus_digest: Schema.optionalKey(Schema.String),
  cloudflare_enabled: Schema.optionalKey(Schema.Boolean),
  cloudflare_account_id: Schema.optionalKey(Schema.String),
  cloudflare_model_slug: Schema.optionalKey(Schema.String),
  cloudflare_adapter_contract_version: Schema.optionalKey(Schema.String),
  cloudflare_corpus_digest: Schema.optionalKey(Schema.String),
  provider_timeout_ms: Schema.optionalKey(Schema.Number),
  max_audio_bytes: Schema.optionalKey(Schema.Number),
  max_audio_seconds: Schema.optionalKey(Schema.Number),
  max_response_bytes: Schema.optionalKey(Schema.Number),
  max_text_chars: Schema.optionalKey(Schema.Number),
  max_segments: Schema.optionalKey(Schema.Number),
  max_words: Schema.optionalKey(Schema.Number),
  provider_max_retries: Schema.optionalKey(Schema.Number),
  retry_base_delay_ms: Schema.optionalKey(Schema.Number),
  retry_max_delay_ms: Schema.optionalKey(Schema.Number),
  circuit_failure_threshold: Schema.optionalKey(Schema.Number),
  circuit_cooldown_ms: Schema.optionalKey(Schema.Number),
  deepinfra_token_parameter_arn: Schema.optionalKey(Schema.String),
  cloudflare_token_parameter_arn: Schema.optionalKey(Schema.String),
  api_workload_auth_parameter_arn: Schema.optionalKey(Schema.String),
  ssm_kms_key_arns: Schema.optionalKey(Schema.Array(Schema.String)),
  log_retention_days: Schema.optionalKey(Schema.Number),
  log_kms_key_arn: Schema.optionalKey(Schema.NullOr(Schema.String)),
  failure_queue_kms_key_arn: Schema.optionalKey(Schema.NullOr(Schema.String)),
  async_max_event_age_seconds: Schema.optionalKey(Schema.Number),
  async_maximum_retry_attempts: Schema.optionalKey(Schema.Number),
  scheduler_name: Schema.optionalKey(Schema.String),
  scheduler_group_name: Schema.optionalKey(Schema.String),
  scheduler_state: Schema.optionalKey(Schema.String),
  scheduler_input_json: Schema.optionalKey(Schema.String),
  scheduler_max_event_age_seconds: Schema.optionalKey(Schema.Number),
  scheduler_maximum_retry_attempts: Schema.optionalKey(Schema.Number),
  alarm_actions: Schema.optionalKey(Schema.Array(Schema.String)),
  control_api_invoker_principal: Schema.optionalKey(Schema.NullOr(Schema.String)),
  control_api_invoke_source_arn: Schema.optionalKey(Schema.NullOr(Schema.String)),
  codeswitch_provider: Schema.optionalKey(Schema.String),
  openrouter_token_parameter_arn: Schema.optionalKey(Schema.String),
});
const defaults = {
  handler: "index.handler",
  timeout_seconds: 600,
  work_budget_seconds: 300,
  completion_reserve_seconds: 60,
  reserved_concurrency: 50,
  memory_size: 1024,
  ephemeral_storage_size: 1024,
  max_batch: 10,
  deepinfra_enabled: false,
  deepinfra_execution_identity_pin: "",
  deepinfra_model_version_pin: "",
  deepinfra_adapter_contract_version: "deepinfra-native-whisper-turbo.v1",
  deepinfra_corpus_digest: "",
  cloudflare_enabled: false,
  cloudflare_account_id: "",
  cloudflare_model_slug: "@cf/openai/whisper-large-v3-turbo",
  cloudflare_adapter_contract_version: "",
  cloudflare_corpus_digest: "",
  provider_timeout_ms: 90000,
  max_audio_bytes: 52428800,
  max_audio_seconds: 900,
  max_response_bytes: 26214400,
  max_text_chars: 2000000,
  max_segments: 100000,
  max_words: 500000,
  provider_max_retries: 2,
  retry_base_delay_ms: 1000,
  retry_max_delay_ms: 30000,
  circuit_failure_threshold: 3,
  circuit_cooldown_ms: 60000,
  deepinfra_token_parameter_arn: "",
  cloudflare_token_parameter_arn: "",
  ssm_kms_key_arns: [],
  log_retention_days: 14,
  log_kms_key_arn: null,
  failure_queue_kms_key_arn: null,
  async_max_event_age_seconds: 3600,
  async_maximum_retry_attempts: 2,
  scheduler_name: "transcription-reconcile",
  scheduler_group_name: "default",
  scheduler_input_json: '{"source":"eventbridge.scheduler","kind":"transcription-reconcile"}',
  scheduler_max_event_age_seconds: 3600,
  scheduler_maximum_retry_attempts: 2,
  alarm_actions: [],
  control_api_invoker_principal: null,
  control_api_invoke_source_arn: null,
  codeswitch_provider: "",
  openrouter_token_parameter_arn: "",
};
export const requireInput = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(message);
};
const validJson = (text: string): boolean => {
  try {
    Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(text);
    return true;
  } catch {
    return false;
  }
};
export const parseInputs = (value: unknown): DispatcherInputs => {
  let input: DispatcherInputs;
  try {
    input = Schema.decodeUnknownSync(inputSchema)({ ...defaults, ...Schema.decodeUnknownSync(partialSchema, { onExcessProperty: "error" })(value) });
  } catch {
    throw new Error("Invalid dispatcher inputs; values are not logged.");
  }
  const validateReleaseIdentity = () => {
    requireInput(new RegExp("^[a-zA-Z0-9-_]{1,64}$").test(input.function_name), "function_name failed validation");
    requireInput(new RegExp("^[a-z][a-z0-9-]{0,31}$").test(input.environment_name), "environment_name failed validation");
    requireInput(new RegExp("^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$").test(input.release_id) && !input.release_id.toLowerCase().includes("latest"), "release_id failed validation");
    requireInput(new RegExp("^sha256:[0-9a-f]{64}$").test(input.release_manifest_digest), "release_manifest_digest failed validation");
  };
  validateReleaseIdentity();
  const validateArtifactLocation = () => {
    requireInput(new RegExp("^sha256:[0-9a-f]{64}$").test(input.config_digest), "config_digest failed validation");
    requireInput(new RegExp("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$").test(input.artifact_s3_bucket), "artifact_s3_bucket failed validation");
    requireInput(input.artifact_s3_key.trim().length > 0 && !input.artifact_s3_key.toLowerCase().includes("latest"), "artifact_s3_key failed validation");
    requireInput(input.artifact_s3_object_version.trim().length > 0 && !input.artifact_s3_object_version.toLowerCase().includes("latest") && input.artifact_s3_object_version.trim().toLowerCase() !== "null", "artifact_s3_object_version failed validation");
  };
  validateArtifactLocation();
  const validateArtifactRuntime = () => {
    requireInput(new RegExp("^[0-9a-f]{64}$").test(input.artifact_sha256), "artifact_sha256 failed validation");
    requireInput(new RegExp("^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$").test(input.artifact_sha256_base64), "artifact_sha256_base64 failed validation");
    requireInput(new RegExp("^[A-Za-z0-9_./-]+$").test(input.handler), "handler failed validation");
    requireInput(Number.isInteger(input.timeout_seconds) && input.timeout_seconds >= 61 && input.timeout_seconds <= 900, "timeout_seconds failed validation");
  };
  validateArtifactRuntime();
  const validateExecutionBounds = () => {
    requireInput(Number.isInteger(input.work_budget_seconds) && input.work_budget_seconds >= 1, "work_budget_seconds failed validation");
    requireInput(Number.isInteger(input.completion_reserve_seconds) && input.completion_reserve_seconds >= 60, "completion_reserve_seconds failed validation");
    requireInput(Number.isInteger(input.reserved_concurrency) && input.reserved_concurrency >= 3 && input.reserved_concurrency <= 50, "reserved_concurrency failed validation");
    requireInput(Number.isInteger(input.memory_size) && input.memory_size >= 128 && input.memory_size <= 4096, "memory_size failed validation");
  };
  validateExecutionBounds();
  const validateProviderLimits = () => {
    requireInput(Number.isInteger(input.ephemeral_storage_size) && input.ephemeral_storage_size >= 512 && input.ephemeral_storage_size <= 4096, "ephemeral_storage_size failed validation");
    requireInput(new RegExp("^https://").test(input.control_api_url), "control_api_url failed validation");
    requireInput(new RegExp("^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$").test(input.control_api_audience), "control_api_audience failed validation");
    requireInput(Number.isInteger(input.max_batch) && input.max_batch >= 3 && input.max_batch <= 50, "max_batch failed validation");
  };
  validateProviderLimits();
  const validateRetryLimits = () => {
    requireInput(input.deepinfra_adapter_contract_version === "deepinfra-native-whisper-turbo.v1", "deepinfra_adapter_contract_version failed validation");
    requireInput(input.deepinfra_corpus_digest === "" || new RegExp("^[a-fA-F0-9]{32,128}$").test(input.deepinfra_corpus_digest), "deepinfra_corpus_digest failed validation");
    requireInput(input.cloudflare_account_id === "" || new RegExp("^[a-f0-9]{32}$").test(input.cloudflare_account_id), "cloudflare_account_id failed validation");
    requireInput(input.cloudflare_model_slug === "@cf/openai/whisper-large-v3-turbo", "cloudflare_model_slug failed validation");
  };
  validateRetryLimits();
  const validateQueueAndScheduler = () => {
    requireInput(input.cloudflare_corpus_digest === "" || new RegExp("^[a-fA-F0-9]{32,128}$").test(input.cloudflare_corpus_digest), "cloudflare_corpus_digest failed validation");
    requireInput(Number.isInteger(input.provider_timeout_ms) && input.provider_timeout_ms >= 100 && input.provider_timeout_ms <= 120000, "provider_timeout_ms failed validation");
    requireInput(Number.isInteger(input.log_retention_days) && input.log_retention_days >= 1 && input.log_retention_days <= 3653, "log_retention_days failed validation");
    requireInput(Number.isInteger(input.async_max_event_age_seconds) && input.async_max_event_age_seconds >= 60 && input.async_max_event_age_seconds <= 21600, "async_max_event_age_seconds failed validation");
  };
  validateQueueAndScheduler();
  const validateSecurityAndActions = () => {
    requireInput(Number.isInteger(input.async_maximum_retry_attempts) && input.async_maximum_retry_attempts >= 0 && input.async_maximum_retry_attempts <= 2, "async_maximum_retry_attempts failed validation");
    requireInput(["DISABLED", "ENABLED"].includes(input.scheduler_state), "scheduler_state failed validation");
    requireInput(validJson(input.scheduler_input_json) && input.scheduler_input_json.length <= 1048576, "scheduler_input_json failed validation");
    requireInput(Number.isInteger(input.scheduler_max_event_age_seconds) && input.scheduler_max_event_age_seconds >= 60 && input.scheduler_max_event_age_seconds <= 86400, "scheduler_max_event_age_seconds failed validation");
  };
  validateSecurityAndActions();
  const validateSchedulerAndArtifactIdentity = () => {
    requireInput(Number.isInteger(input.scheduler_maximum_retry_attempts) && input.scheduler_maximum_retry_attempts >= 0 && input.scheduler_maximum_retry_attempts <= 185, "scheduler_maximum_retry_attempts failed validation");
    requireInput(["", "mai"].includes(input.codeswitch_provider), "codeswitch_provider failed validation");
    requireInput(input.openrouter_token_parameter_arn === "" || new RegExp("^arn:aws:ssm:[a-z0-9-]+:[0-9]{12}:parameter/chalk/").test(input.openrouter_token_parameter_arn), "openrouter_token_parameter_arn failed validation");
    requireInput(input.artifact_s3_key.includes(input.release_id), "artifact key must contain release_id");
  };
  validateSchedulerAndArtifactIdentity();
  const validateQualifiedProviders = () => {
    requireInput(Buffer.from(input.artifact_sha256, "hex").toString("base64") === input.artifact_sha256_base64, "artifact SHA-256 encodings disagree");
    requireInput(input.timeout_seconds - input.work_budget_seconds >= input.completion_reserve_seconds, "timeout must leave the completion reserve after bounded work");
    requireInput(!input.deepinfra_enabled || (input.deepinfra_token_parameter_arn.length > 0 && input.deepinfra_corpus_digest.length > 0), "DeepInfra requires credentials and corpus evidence");
    requireInput(!input.cloudflare_enabled || [input.cloudflare_token_parameter_arn, input.cloudflare_account_id, input.cloudflare_adapter_contract_version, input.cloudflare_corpus_digest].every((value) => value.length > 0), "Cloudflare requires credentials and conformance evidence");
  };
  validateQualifiedProviders();
  const validateProviderSelection = () => {
    requireInput(input.deepinfra_enabled || input.cloudflare_enabled, "Select at least one qualified provider");
    requireInput((input.control_api_invoker_principal === null) === (input.control_api_invoke_source_arn === null), "Configure both control API permission fields, or neither");
    requireInput(input.codeswitch_provider !== "mai" || new RegExp(`^arn:aws:ssm:[a-z0-9-]+:[0-9]{12}:parameter/chalk/${input.environment_name}/`).test(input.openrouter_token_parameter_arn), "MAI requires an environment-scoped secret ARN");
  };
  validateProviderSelection();
  return input;
};
