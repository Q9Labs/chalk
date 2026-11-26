import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInputs, type DocumentRendererInputs } from "./config.ts";
import { resourceProps } from "./resources.ts";
import { rendererPolicy, resourceTypes, type Operation } from "./policy.ts";
import { checkPlan, object, type Plan } from "../releases/policy.ts";
import { jsonValue } from "../releases/plan-view.ts";

const original = parseInputs({
  function_name: "chalk-nightly-test-document-renderer",
  environment_name: "nightly-test",
  release_id: "release-old",
  release_manifest_digest: `sha256:${"ab".repeat(32)}`,
  config_digest: `sha256:${"cd".repeat(32)}`,
  artifact_s3_bucket: "test-artifacts",
  artifact_s3_key: "document-renderer/release-old/renderer.zip",
  artifact_s3_object_version: "old-version",
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
});
function declaration(input: DocumentRendererInputs) {
  const props = resourceProps(input, "0".repeat(12), "ap-southeast-1");
  return {
    resources: [["Function", props.fn], ["Logs", props.log], ["ExecutionRole", props.executionRole], ...Object.entries(props.alarms)].map(([id, value]) => {
      if (typeof id !== "string") throw new Error("Fixture ID missing");
      const type = Object.entries(resourceTypes).find(([name]) => name === id)?.[1];
      if (!type) throw new Error("Fixture resource type missing");
      return { id, type, props: jsonValue(value) };
    }),
    output: jsonValue(props.outputs),
  };
}
function fixture(input = original, previous = original) {
  const before = declaration(previous),
    after = declaration(input);
  return {
    resources: before.resources.map((row) => {
      const desired = after.resources.find((item) => item.id === row.id);
      if (!desired) throw new Error("Fixture resource missing");
      return { id: row.id, type: row.type, action: JSON.stringify(row.props) === JSON.stringify(desired.props) ? "noop" : "update", before: row.props, after: desired.props };
    }),
    outputs: { before: before.output, after: after.output },
  };
}
function verify(plan: Plan, input = original, operation: Operation = "noop") {
  const checked = rendererPolicy(plan, input, operation);
  checkPlan(checked.plan, checked.policy);
}
function change(plan: ReturnType<typeof fixture>, name: string) {
  const row = plan.resources.find((row) => row.id === name);
  if (!row) throw new Error("Fixture resource missing");
  row.action = "update";
  return object(row.after);
}

test("complete renderer noop is safe", () => verify(fixture()));
test("renderer rejects dangerous actions and partial plans", () => {
  for (const action of ["delete", "replace", "create", "adopted"]) {
    const plan = fixture();
    const row = plan.resources.find((row) => row.id === "Function");
    if (!row) throw new Error("Fixture missing Function");
    row.action = action;
    assert.throws(() => verify(plan), /must not create/);
  }
  const partial = fixture();
  partial.resources.pop();
  assert.throws(() => verify(partial), /partial/);
});
const release = parseInputs({
  ...original,
  release_id: "release-new",
  artifact_s3_key: "document-renderer/release-new/renderer.zip",
  artifact_s3_object_version: "new-version",
  artifact_sha256: "34".repeat(32),
  artifact_sha256_base64: Buffer.from("34".repeat(32), "hex").toString("base64"),
  release_manifest_digest: `sha256:${"56".repeat(32)}`,
  config_digest: `sha256:${"12".repeat(32)}`,
});
test("renderer release changes only exact artifact and release metadata", () => {
  verify(fixture(release), release, "release");
  for (const [field, value] of [
    ["timeout", 301],
    ["memorySize", 4096],
  ] as const) {
    const plan = fixture(release);
    change(plan, "Function")[field] = value;
    assert.throws(() => verify(plan, release, "release"), /outside the allowlist/);
  }
  const plan = fixture(release);
  change(plan, "Logs").retention = "7 days";
  assert.throws(() => verify(plan, release, "release"), /outside the allowlist/);
});
