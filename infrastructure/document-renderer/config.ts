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
});
export type DocumentRendererInputs = typeof inputSchema.Type;
export const requireInput = (condition: boolean, message: string): void => {
  if (!condition) throw new Error(`document-renderer inputs: ${message}`);
};
export const parseInputs = (value: unknown): DocumentRendererInputs => {
  const decoded = Schema.decodeUnknownSync(inputSchema)(value);
  const input = decoded;
  requireInput(/^[a-z0-9-]{8,64}$/.test(input.function_name), "function_name failed validation");
  requireInput(input.release_id.length > 0 && input.artifact_s3_key.includes(input.release_id), "artifact key must contain release_id");
  requireInput(Buffer.from(input.artifact_sha256, "hex").toString("base64") === input.artifact_sha256_base64, "artifact SHA-256 encodings disagree");
  requireInput(Number.isInteger(input.memory_size) && input.memory_size >= 1024 && input.memory_size <= 10240, "memory_size must be an integer between 1024 and 10240 MB");
  requireInput(input.timeout_seconds >= 60 && input.timeout_seconds <= 900, "timeout_seconds failed validation");
  requireInput(input.reserved_concurrency >= 1 && input.reserved_concurrency <= 64, "reserved_concurrency failed validation");
  requireInput((input.control_api_invoker_principal === null) === (input.control_api_invoke_source_arn === null), "Configure both control API permission fields, or neither");
  const stage = parseStage(input.environment_name);
  if (stage.kind === "ephemeral") {
    requireInput(input.function_name === `chalk-${stage.name}-document-renderer`, "Ephemeral function_name must be derived from its stage");
  }
  return input;
};
