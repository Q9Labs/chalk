import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInputs } from "./config.ts";
import { resourceProps } from "./resources.ts";
import { buildEnvironment } from "./environment.ts";

const valid = {
  function_name: "chalk-nightly-test-transcription-dispatcher",
  environment_name: "nightly-test",
  release_id: "release-test-01",
  release_manifest_digest: `sha256:${"ab".repeat(32)}`,
  config_digest: `sha256:${"cd".repeat(32)}`,
  artifact_s3_bucket: "test-versioned-artifacts",
  artifact_s3_key: "release-test-01/dispatcher.zip",
  artifact_s3_object_version: "concrete-version",
  artifact_sha256: "ab".repeat(32),
  artifact_sha256_base64: Buffer.from("ab".repeat(32), "hex").toString("base64"),
  control_api_url: "https://api.example.test",
  control_api_audience: "test-control-api",
  api_workload_auth_parameter_arn: "workload-parameter",
  scheduler_name: "chalk-nightly-test-transcription-reconcile",
  scheduler_state: "DISABLED",
  privacy_gate_accepted: true,
  deepinfra_enabled: true,
  deepinfra_token_parameter_arn: "provider-parameter",
  deepinfra_corpus_digest: "ef".repeat(32),
};

test("MAI can be the only configured provider", () => {
  const arn = "arn:aws:ssm:ap-southeast-1:012345678901:parameter/chalk/nightly-test/openrouter";
  const input = parseInputs({ ...valid, deepinfra_enabled: false, codeswitch_provider: "mai", openrouter_token_parameter_arn: arn });
  const env = buildEnvironment(input);
  assert.equal(env.OPENROUTER_TOKEN_PARAMETER_ARN, arn);
  assert.equal("DEEPINFRA_TOKEN_PARAMETER_ARN" in env, false);
  assert.equal("CLOUDFLARE_AI_TOKEN_PARAMETER_ARN" in env, false);
});

test("defaults preserve timing and explicitly enabled providers; runtime receives only configured SSM authorities", () => {
  const input = parseInputs(valid);
  const env = buildEnvironment(input);
  assert.equal(input.timeout_seconds - input.work_budget_seconds >= input.completion_reserve_seconds, true);
  assert.equal(env.TRANSCRIPTION_TIMEOUT_RESERVE_MS, "60000");
  assert.equal(env.DEEPINFRA_TOKEN_PARAMETER_ARN, "provider-parameter");
  for (const absent of ["CODESWITCH_PROVIDER", "OPENROUTER_TOKEN_PARAMETER_ARN", "DEEPINFRA_EXECUTION_IDENTITY_PIN", "DEEPINFRA_MODEL_VERSION_PIN", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_AI_TOKEN_PARAMETER_ARN"]) assert.equal(absent in env, false);
});

const invalid = [
  { function_name: "invalid name" },
  { environment_name: "Nightly" },
  { release_id: "release-latest" },
  { release_manifest_digest: "not-a-digest" },
  { config_digest: "not-a-digest" },
  { artifact_s3_bucket: "INVALID" },
  { artifact_s3_key: "latest.zip" },
  { artifact_s3_key: "other-release.zip" },
  { artifact_s3_object_version: "null" },
  { artifact_sha256: "00".repeat(32) },
  { artifact_sha256_base64: "invalid" },
  { handler: "bad handler" },
  { timeout_seconds: 60 },
  { timeout_seconds: 901 },
  { timeout_seconds: 61.5 },
  { work_budget_seconds: 0 },
  { completion_reserve_seconds: 59 },
  { timeout_seconds: 350 },
  { reserved_concurrency: 2 },
  { reserved_concurrency: 51 },
  { memory_size: 127 },
  { memory_size: 4097 },
  { ephemeral_storage_size: 511 },
  { ephemeral_storage_size: 4097 },
  { control_api_url: "http://api.example.test" },
  { control_api_audience: "invalid audience" },
  { max_batch: 2 },
  { max_batch: 51 },
  { deepinfra_adapter_contract_version: "unqualified" },
  { deepinfra_corpus_digest: "not-hex" },
  { deepinfra_token_parameter_arn: "" },
  { deepinfra_enabled: false },
  { cloudflare_enabled: true },
  { cloudflare_account_id: "invalid" },
  { cloudflare_model_slug: "unqualified" },
  { cloudflare_corpus_digest: "not-hex" },
  { provider_timeout_ms: 99 },
  { provider_timeout_ms: 120001 },
  { log_retention_days: 0 },
  { log_retention_days: 3654 },
  { async_max_event_age_seconds: 59 },
  { async_max_event_age_seconds: 21601 },
  { async_maximum_retry_attempts: 3 },
  { scheduler_state: "MAYBE" },
  { scheduler_input_json: "{" },
  { scheduler_input_json: JSON.stringify("a".repeat(1048576)) },
  { scheduler_max_event_age_seconds: 59 },
  { scheduler_max_event_age_seconds: 86401 },
  { scheduler_maximum_retry_attempts: 186 },
  { control_api_invoker_principal: "service.amazonaws.com" },
  { codeswitch_provider: "other" },
  { codeswitch_provider: "mai" },
  { openrouter_token_parameter_arn: "not-an-arn" },
  { unexpected_input: true },
];
for (const update of invalid) {
  test(`invalid input is rejected before planning: ${Object.keys(update).join(",")}`, () => assert.throws(() => parseInputs({ ...valid, ...update })));
}

test("ephemeral names isolate concurrent runs and reject persistent Nightly", () => {
  const inputs = ["nightly-one", "nightly-two"].map((stage) => parseInputs({ ...valid, environment_name: stage, function_name: `chalk-${stage}-transcription-dispatcher`, scheduler_name: `chalk-${stage}-transcription-reconcile` }));
  const names = inputs.map((input) => {
    const props = resourceProps(input, "000000000000", "ap-southeast-1");
    return [props.log.logGroupName, props.asyncFailure.queueName, props.schedulerDlq.queueName, props.executionRole.roleName, props.schedulerRole.roleName, props.fn.functionName, props.schedule.name, ...Object.values(props.alarms).map((alarm) => alarm.name)];
  });
  assert.equal(names[0]?.length, 12);
  for (const name of names[0] ?? []) assert.ok(name && !names[1]?.includes(name));
  assert.throws(() => parseInputs({ ...valid, environment_name: "nightly" }));
  assert.throws(() => parseInputs({ ...valid, function_name: "chalk-other-transcription-dispatcher" }));
  assert.throws(() => parseInputs({ ...valid, scheduler_state: "ENABLED" }));
});

// SQS rewrites a queue policy on write: one-element lists inside a statement become bare strings, and statement keys take SQS's own order. The state record keeps the declared text, so any other form reads back as drift.
const statementKeyOrder = ["Sid", "Effect", "Principal", "Action", "Resource", "Condition"];
const collapseLists = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.length === 1 ? collapseLists(value[0]) : value.map(collapseLists);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, collapseLists(child)]));
  return value;
};
const sqsStoredPolicy = (policy: { Version: string; Statement: object[] }) => ({
  ...policy,
  Statement: policy.Statement.map((statement) => Object.fromEntries(Object.entries(collapseLists(statement) as object).sort(([left], [right]) => statementKeyOrder.indexOf(left) - statementKeyOrder.indexOf(right)))),
});

test("queue policies are declared in the form SQS stores, so the recorded policy equals the live read", () => {
  const props = resourceProps(parseInputs(valid), "000000000000", "ap-southeast-1");
  for (const queue of [props.asyncFailure, props.schedulerDlq]) {
    assert.ok(queue.policy);
    assert.equal(JSON.stringify(sqsStoredPolicy(JSON.parse(String(queue.policy)))), queue.policy);
  }
});
