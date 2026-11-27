import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInputs } from "./config.ts";
import { resourceProps } from "./resources.ts";
import { buildEnvironment } from "./environment.ts";

const valid = {
  function_name: "chalk-nightly-test-document-renderer",
  environment_name: "nightly-test",
  release_id: "release-test-01",
  release_manifest_digest: `sha256:${"ab".repeat(32)}`,
  config_digest: `sha256:${"cd".repeat(32)}`,
  artifact_s3_bucket: "test-versioned-artifacts",
  artifact_s3_key: "document-renderer/release-test-01/renderer.zip",
  artifact_s3_object_version: "concrete-version",
  artifact_sha256: "ab".repeat(32),
  artifact_sha256_base64: Buffer.from("ab".repeat(32), "hex").toString("base64"),
  timeout_seconds: 300,
  reserved_concurrency: 4,
  memory_size: 2048,
  ephemeral_storage_size: 1024,
  control_api_url: "https://api.example.test",
  log_retention_days: 30,
  log_kms_key_arn: null,
  failure_queue_kms_key_arn: null,
  async_max_event_age_seconds: 3600,
  async_maximum_retry_attempts: 1,
  alarm_actions: [],
  control_api_invoker_principal: null,
  control_api_invoke_source_arn: null,
  control_api_invoker_role_name: null,
};

test("renderer environment carries release identity and control API only", () => {
  const input = parseInputs(valid);
  const env = buildEnvironment(input);
  assert.equal(env.CHALK_RELEASE_ID, "release-test-01");
  assert.equal(env.CONTROL_API_BASE_URL, "https://api.example.test");
  assert.equal(env.AWS_REGION, undefined);
  const props = resourceProps(input, "000000000000", "ap-southeast-1");
  assert.equal(props.controlPermission, undefined);
  assert.equal(props.controlApiInvokePolicy, undefined);
});

test("production requires explicit API invoke access", () => {
  const production = { ...valid, function_name: "chalk-production-document-renderer", environment_name: "production" };
  assert.throws(() => parseInputs(production), /invoke access/);
  const input = parseInputs({ ...production, control_api_invoker_role_name: "chalk-production-host" });
  const props = resourceProps(input, "000000000000", "ap-southeast-1");
  assert.equal(props.controlApiInvokePolicy?.roleName, "chalk-production-host");
  assert.match(props.controlApiInvokePolicy?.policy ?? "", /InvokeDocumentRendererOnly/);
});

const invalid = [
  { function_name: "invalid name" },
  { artifact_s3_key: "document-renderer/other-release/renderer.zip" },
  { artifact_sha256_base64: "invalid" },
  { memory_size: 1023 },
  { timeout_seconds: 59 },
  { reserved_concurrency: 0 },
  { control_api_invoker_principal: "service.amazonaws.com" },
  { control_api_invoker_role_name: "invalid role" },
  { unexpected_input: true },
];
for (const update of invalid) {
  test(`invalid renderer input is rejected before planning: ${Object.keys(update).join(",")}`, () => assert.throws(() => parseInputs({ ...valid, ...update })));
}

test("ephemeral renderer names isolate concurrent runs", () => {
  const inputs = ["nightly-one", "nightly-two"].map((stage) => parseInputs({ ...valid, environment_name: stage, function_name: `chalk-${stage}-document-renderer` }));
  const names = inputs.map((input) => {
    const props = resourceProps(input, "000000000000", "ap-southeast-1");
    return [props.log.logGroupName, props.executionRole.roleName, props.fn.functionName, ...Object.values(props.alarms).map((alarm) => alarm.name)];
  });
  for (const name of names[0] ?? []) assert.ok(name && !names[1]?.includes(name));
  assert.throws(() => parseInputs({ ...valid, function_name: "chalk-other-document-renderer" }));
});
