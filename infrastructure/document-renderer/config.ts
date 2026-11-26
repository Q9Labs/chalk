import * as Schema from "effect/Schema";
import { parseStage } from "../platform/stages.ts";

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
  timeout_seconds: Schema.Number,
  reserved_concurrency: Schema.Number,
  memory_size: Schema.Number,
  ephemeral_storage_size: Schema.Number,
  control_api_url: Schema.String,
  log_retention_days: Schema.Number,
  log_kms_key_arn: Schema.NullOr(Schema.String),
  failure_queue_kms_key_arn: Schema.NullOr(Schema.String),
  async_max_event_age_seconds: Schema.Number,
  async_maximum_retry_attempts: Schema.Number,
  alarm_actions: Schema.Array(Schema.String),
  control_api_invoker_principal: Schema.NullOr(Schema.String),
  control_api_invoke_source_arn: Schema.NullOr(Schema.String),
  control_api_invoker_role_name: Schema.NullOr(Schema.String),
});
export type DocumentRendererInputs = typeof inputSchema.Type;
export const requireInput = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`document-renderer inputs: ${message}`);
};
const inRange = (value: number, min: number, max: number): boolean => Number.isInteger(value) && value >= min && value <= max;

const checkIdentity = (input: DocumentRendererInputs): void => {
  requireInput(/^[a-z0-9-]{8,64}$/.test(input.function_name), "function_name failed validation");
  requireInput(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(input.release_id) && !input.release_id.toLowerCase().includes("latest"), "release_id failed validation");
  requireInput(/^sha256:[0-9a-f]{64}$/.test(input.release_manifest_digest), "release_manifest_digest failed validation");
  requireInput(/^sha256:[0-9a-f]{64}$/.test(input.config_digest), "config_digest failed validation");
  requireInput(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.artifact_s3_bucket), "artifact_s3_bucket failed validation");
};

const checkArtifact = (input: DocumentRendererInputs): void => {
  requireInput(input.release_id.length > 0 && input.artifact_s3_key.includes(input.release_id) && !input.artifact_s3_key.includes("..") && !input.artifact_s3_key.toLowerCase().includes("latest"), "artifact key must be immutable and contain release_id");
  requireInput(input.artifact_s3_object_version.length > 0 && input.artifact_s3_object_version !== "null", "artifact_s3_object_version must pin a concrete S3 version");
  requireInput(/^[0-9a-f]{64}$/.test(input.artifact_sha256), "artifact_sha256 failed validation");
  requireInput(Buffer.from(input.artifact_sha256, "hex").toString("base64") === input.artifact_sha256_base64, "artifact SHA-256 encodings disagree");
};

const checkLimits = (input: DocumentRendererInputs): void => {
  requireInput(inRange(input.memory_size, 1024, 10240), "memory_size must be an integer between 1024 and 10240 MB");
  requireInput(inRange(input.timeout_seconds, 60, 900), "timeout_seconds failed validation");
  requireInput(inRange(input.reserved_concurrency, 1, 64), "reserved_concurrency failed validation");
  requireInput(inRange(input.ephemeral_storage_size, 512, 10240), "ephemeral_storage_size failed validation");
  requireInput(/^https:\/\//.test(input.control_api_url), "control_api_url must use HTTPS");
  requireInput(inRange(input.log_retention_days, 1, 3653), "log_retention_days failed validation");
  requireInput(inRange(input.async_max_event_age_seconds, 60, 21600), "async_max_event_age_seconds failed validation");
  requireInput(inRange(input.async_maximum_retry_attempts, 0, 2), "async_maximum_retry_attempts failed validation");
};

const checkControlApi = (input: DocumentRendererInputs): void => {
  const stage = parseStage(input.environment_name);
  requireInput((input.control_api_invoker_principal === null) === (input.control_api_invoke_source_arn === null), "Configure both control API permission fields, or neither");
  requireInput(input.control_api_invoker_role_name === null || /^[A-Za-z0-9+=,.@_-]{1,64}$/.test(input.control_api_invoker_role_name), "control_api_invoker_role_name must be a valid IAM role name");
  if (stage.kind === "production") requireInput(input.control_api_invoker_role_name !== null || input.control_api_invoker_principal !== null, "Production needs API invoke access through control_api_invoker_role_name or the resource permission fields");
  if (stage.kind === "ephemeral") {
    requireInput(input.function_name === `chalk-${stage.name}-document-renderer`, "Ephemeral function_name must be derived from its stage");
  }
};

export const parseInputs = (value: unknown): DocumentRendererInputs => {
  const input = Schema.decodeUnknownSync(inputSchema)(value, { onExcessProperty: "error" });
  checkIdentity(input);
  checkArtifact(input);
  checkLimits(input);
  checkControlApi(input);
  return input;
};
