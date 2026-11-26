import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInputs, type DispatcherInputs } from "../transcription-dispatcher/config.ts";
import { resourceProps } from "../transcription-dispatcher/resources.ts";
import { dispatcherPolicy, resourceTypes, type Operation } from "../transcription-dispatcher/policy.ts";
import { checkPlan, object, type Plan } from "./policy.ts";
import { blockingDrift, jsonValue } from "./plan-view.ts";
import { isRecoverableReleaseDrift } from "../providers/aws-release-drift.ts";

const original = parseInputs({
  function_name: "chalk-nightly-test-transcription-dispatcher",
  environment_name: "nightly-test",
  release_id: "release-old",
  release_manifest_digest: `sha256:${"ab".repeat(32)}`,
  config_digest: `sha256:${"cd".repeat(32)}`,
  artifact_s3_bucket: "test-artifacts",
  artifact_s3_key: "release-old/code.zip",
  artifact_s3_object_version: "old-version",
  artifact_sha256: "ab".repeat(32),
  artifact_sha256_base64: Buffer.from("ab".repeat(32), "hex").toString("base64"),
  control_api_url: "https://api.example.test",
  control_api_audience: "test-control-api",
  api_workload_auth_parameter_arn: "arn:workload",
  scheduler_name: "chalk-nightly-test-transcription-reconcile",
  scheduler_state: "DISABLED",
  privacy_gate_accepted: true,
  deepinfra_enabled: true,
  deepinfra_token_parameter_arn: "arn:provider",
  deepinfra_corpus_digest: "ef".repeat(32),
  ssm_kms_key_arns: ["arn:kms"],
});

function declaration(input: DispatcherInputs) {
  const props = resourceProps(input, "0".repeat(12), "ap-southeast-1");
  return {
    resources: [
      ["Function", props.fn],
      ["Logs", props.log],
      ["Reconcile", props.schedule],
      ["ExecutionRole", props.executionRole],
      ["SchedulerRole", props.schedulerRole],
      ["AsyncFailure", props.asyncFailure],
      ["SchedulerDlq", props.schedulerDlq],
      ["SchedulerPermission", props.schedulerPermission],
      ...Object.entries(props.alarms),
    ].map(([id, value]) => {
      if (typeof id !== "string") throw new Error("Fixture ID missing");
      const type = Object.entries(resourceTypes).find(([name]) => name === id)?.[1];
      if (!type) throw new Error("Fixture resource type missing");
      return { id, type, props: jsonValue(value) };
    }),
    output: jsonValue(props.outputs),
  };
}

function fixture(input = original, previous = original) {
  const before = declaration(previous);
  const after = declaration(input);
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
  const checked = dispatcherPolicy(plan, input, operation);
  checkPlan(checked.plan, checked.policy);
}

test("dispatcher policy still rejects noop-plan updates, including a no-delta Lambda update", () => {
  const changed = fixture();
  const row = changed.resources.find((row) => row.id === "Function");
  if (!row) throw new Error("Fixture missing Function");
  row.action = "update";
  object(row.after).timeout = 900;
  assert.throws(() => verify(changed), /exceeds resource allowlist|outside the allowlist/);

  const identical = fixture();
  const fn = identical.resources.find((row) => row.id === "Function");
  if (!fn) throw new Error("Fixture missing Function");
  fn.action = "update";
  assert.equal(JSON.stringify(fn.before), JSON.stringify(fn.after));
  assert.throws(() => verify(identical), /exceeds resource allowlist/);
});

test("dispatcher drift stays blocking without the opt-in, even for tagged partial Lambda drift", () => {
  const configuration = (release: string) => ({
    description: `proof (${release})`,
    environment: { CHALK_RELEASE_ID: release, STATIC: "same" },
    tags: { chalk_release_id: release, chalk_config_digest: `config-${release}`, chalk_release_manifest_digest: `manifest-${release}`, static: "same" },
    timeout: 30,
  });
  const persisted = { functionName: "fn", functionArn: "arn", version: "$LATEST", codeSha256: "old", configuration: configuration("release-old") };
  const partial = { ...persisted, codeSha256: "new", configuration: configuration("release-new") };
  assert.equal(isRecoverableReleaseDrift(persisted, partial), true);
  assert.equal(blockingDrift("Function", { action: "drifted", resourceType: "Chalk.Lambda.VersionedFunction", attr: partial }, { state: { attr: persisted } }), true);
});
