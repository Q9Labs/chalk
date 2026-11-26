import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseInputs } from "./config.ts";
import { resourceProps } from "./resources.ts";

const valid = {
  function_name: "chalk-nightly-test-document-renderer",
  environment_name: "nightly-test",
  release_id: "release-test-01",
  release_manifest_digest: `sha256:${"ab".repeat(32)}`,
  config_digest: `sha256:${"cd".repeat(32)}`,
  artifact_s3_bucket: "test-versioned-artifacts",
  artifact_s3_key: "release-test-01/renderer.zip",
  artifact_s3_object_version: "concrete-version",
  artifact_sha256: "ab".repeat(32),
  artifact_sha256_base64: Buffer.from("ab".repeat(32), "hex").toString("base64"),
  timeout_seconds: 180,
  reserved_concurrency: 4,
  memory_size: 2048,
  ephemeral_storage_size: 1024,
  control_api_url: "https://api.example.test",
  log_retention_days: 14,
  log_kms_key_arn: null,
  failure_queue_kms_key_arn: null,
  async_max_event_age_seconds: 300,
  async_maximum_retry_attempts: 0,
  alarm_actions: [],
  control_api_invoker_principal: null,
  control_api_invoke_source_arn: null,
};

test("document renderer async invocation retries are disabled explicitly", () => {
  const input = parseInputs(valid);
  const props = resourceProps(input, "012345678901", "us-east-1");
  assert.deepEqual(props.fn.eventInvokeConfig, { maximumEventAge: 300, maximumRetryAttempts: 0 });
  assert.throws(() => parseInputs({ ...valid, async_maximum_retry_attempts: 1 }), /async_maximum_retry_attempts must be 0/);
  assert.throws(() => parseInputs({ ...valid, async_max_event_age_seconds: 60 }), /async_max_event_age_seconds must be 300/);
});

test("document renderer errors alarm counts reported failures rather than deliberate recycles", () => {
  const input = parseInputs(valid);
  const props = resourceProps(input, "012345678901", "us-east-1");
  assert.equal(props.failureLogMetric.filterPattern, '{ $.msg = "render invocation failed; recycling execution environment" }');
  assert.deepEqual(props.failureLogMetric.metricTransformations, [{ metricName: `RenderInvocationFailures-${input.function_name}`, metricNamespace: "Chalk/DocumentRenderer", metricValue: "1" }]);
  assert.equal(props.alarms.Errors.Namespace, "Chalk/DocumentRenderer");
  assert.equal(props.alarms.Errors.MetricName, `RenderInvocationFailures-${input.function_name}`);
  assert.equal(props.alarms.Errors.Dimensions, undefined);
  const rendererMain = readFileSync(new URL("../../apps/document-renderer/cmd/renderer/main.go", import.meta.url), "utf8");
  assert.ok(rendererMain.includes('"render invocation failed; recycling execution environment"'));
});
