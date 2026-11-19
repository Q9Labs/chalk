import assert from "node:assert/strict";
import { test } from "node:test";
import { parseInputs, type DispatcherInputs } from "./config.ts";
import { resourceProps } from "./resources.ts";
import { dispatcherPolicy, resourceTypes, type Operation } from "./policy.ts";
import { checkPlan, at, object, plainPlan, type Plan } from "../releases/policy.ts";
import { jsonValue } from "../releases/plan-view.ts";

const original = parseInputs({
  function_name: "test-dispatcher", environment_name: "nightly", release_id: "release-old", release_manifest_digest: `sha256:${"ab".repeat(32)}`,
  config_digest: `sha256:${"cd".repeat(32)}`, artifact_s3_bucket: "test-artifacts", artifact_s3_key: "release-old/code.zip",
  artifact_s3_object_version: "old-version", artifact_sha256: "ab".repeat(32), artifact_sha256_base64: Buffer.from("ab".repeat(32), "hex").toString("base64"),
  control_api_url: "https://api.example.test", control_api_audience: "test-control-api", api_workload_auth_parameter_arn: "arn:workload",
  scheduler_state: "DISABLED", privacy_gate_accepted: true, deepinfra_enabled: true, deepinfra_token_parameter_arn: "arn:provider", deepinfra_corpus_digest: "ef".repeat(32),
  ssm_kms_key_arns: ["arn:kms"],
});
function declaration(input: DispatcherInputs) {
  const props = resourceProps(input, "0".repeat(12), "ap-southeast-1");
  return {
    resources: [
      ["Function", props.fn], ["Logs", props.log], ["Reconcile", props.schedule], ["ExecutionRole", props.executionRole], ["SchedulerRole", props.schedulerRole],
      ["AsyncFailure", props.asyncFailure], ["SchedulerDlq", props.schedulerDlq], ["SchedulerPermission", props.schedulerPermission], ...Object.entries(props.alarms),
    ].map(([id, value]) => {
      if (typeof id !== "string") throw new Error("Fixture ID missing");
      const type = Object.entries(resourceTypes).find(([name]) => name === id)?.[1];
      if (!type) throw new Error("Fixture resource type missing");
      return { id, type, props: jsonValue(value) };
    }), output: jsonValue(props.outputs),
  };
}
function fixture(input = original) {
  const before = declaration(original), after = declaration(input);
  return { resources: before.resources.map((row) => {
    const desired = after.resources.find((item) => item.id === row.id);
    if (!desired) throw new Error("Fixture resource missing");
    return { id: row.id, type: row.type, action: JSON.stringify(row.props) === JSON.stringify(desired.props) ? "noop" : "update", before: row.props, after: desired.props };
  }), outputs: { before: before.output, after: after.output } };
}
function verify(plan: Plan, input = original, operation: Operation = "noop") {
  const checked = dispatcherPolicy(plan, input, operation);
  checkPlan(checked.plan, checked.policy);
}
function change(plan: ReturnType<typeof fixture>, name: string) {
  const row = plan.resources.find((row) => row.id === name);
  if (!row) throw new Error("Fixture resource missing");
  row.action = "update";
  return object(row.after);
}
test("complete_noop_is_safe", () => verify(fixture()));
test("rejects_dangerous_actions_even_for_allowlisted_resources", () => {
  for (const action of ["delete", "orphaned", "replace", "create", "adopted"]) {
    const plan = fixture();
    const row = plan.resources.find((row) => row.id === "Function");
    if (!row) throw new Error("Fixture missing Function");
    row.action = action;
    assert.throws(() => verify(plan), /must not create/);
  }
});
test("rejects_partial_plan_and_resource_type_swap", () => {
  const partial = fixture(); partial.resources.pop();
  assert.throws(() => verify(partial), /partial/);
  const swapped = fixture(); const row = swapped.resources.find((row) => row.id === "Function");
  if (!row) throw new Error("Fixture missing Function");
  row.type = "AWS.IAM.User";
  assert.throws(() => verify(swapped), /unexpected resource/);
  const duplicate = fixture(); duplicate.resources.push(structuredClone(row));
  assert.throws(() => verify(duplicate), /unexpected resource/);
});
const binding = parseInputs({ ...original, release_id: "release-new", artifact_s3_key: "release-new/code.zip", artifact_s3_object_version: "new-version", config_digest: `sha256:${"12".repeat(32)}` });
test("binding_changes_only_release_identity", () => {
  verify(fixture(binding), binding, "binding");
  for (const [field, value] of [["timeout", 900], ["role", "expanded-role"]] as const) {
    const plan = fixture(binding); change(plan, "Function")[field] = value;
    assert.throws(() => verify(plan, binding, "binding"), /outside the allowlist/);
  }
  const plan = fixture(binding); object(change(plan, "Function").code).sha256 = "different-bytes";
  assert.throws(() => verify(plan, binding, "binding"), /outside the allowlist/);
});
const release = parseInputs({ ...binding, artifact_sha256: "34".repeat(32), artifact_sha256_base64: Buffer.from("34".repeat(32), "hex").toString("base64"), release_manifest_digest: `sha256:${"56".repeat(32)}`, deepinfra_corpus_digest: "78".repeat(32), scheduler_state: "ENABLED" });
test("media_release_changes_only_exact_artifact_and_metadata", () => {
  verify(fixture(release), release, "release");
  const plan = fixture(release); change(plan, "Reconcile").scheduleExpression = "rate(1 hour)";
  assert.throws(() => verify(plan, release, "release"), /outside the allowlist/);
});
const secret = `arn:aws:ssm:ap-southeast-1:${"0".repeat(12)}:parameter/chalk/nightly/mai`;
const mai = parseInputs({ ...original, codeswitch_provider: "mai", openrouter_token_parameter_arn: secret, config_digest: `sha256:${"90".repeat(32)}` });
test("mai_does_not_expand_other_permissions_or_change_code", () => {
  verify(fixture(mai), mai, "mai");
  const permissions = plainPlan(fixture(mai));
  const policies = object(at(change(permissions, "ExecutionRole"), ["inlinePolicies"]));
  const policy = Object.values(policies)[0];
  if (!policy) throw new Error("Fixture policy missing");
  const statements = object(policy).Statement;
  if (!Array.isArray(statements)) throw new Error("Fixture statements missing");
  const statement = statements.find((row) => object(row).Sid === "ReadOnlyTranscriptionAndApiSecrets");
  object(statement).Action = ["ssm:GetParameter", "ssm:GetParametersByPath"];
  assert.throws(() => verify(permissions, mai, "mai"), /outside the allowlist/);
  const code = fixture(mai); object(change(code, "Function").code).sha256 = "different-bytes";
  assert.throws(() => verify(code, mai, "mai"), /outside the allowlist/);
});
test("unrelated_outputs_and_noop_prop_changes_are_rejected", () => {
  const outputs = plainPlan(fixture()); object(outputs.outputs.after).unrelated = "changed";
  assert.throws(() => verify(outputs), /names changed/);
  const props = plainPlan(fixture()); const row = props.resources.find((row) => row.id === "Function");
  if (!row) throw new Error("Fixture missing Function");
  object(row.after).extra = "unapproved";
  assert.throws(() => verify(props), /outside the allowlist/);
});
test("requested inputs must match and inactive inputs cannot change", () => {
  const mismatch = plainPlan(fixture(binding));
  object(mismatch.outputs.after).dispatcher_inputs = jsonValue(original);
  assert.throws(() => verify(mismatch, binding, "binding"), /requested configuration/);
  const inactive = parseInputs({ ...original, deepinfra_model_version_pin: "inactive-change" });
  assert.throws(() => verify(fixture(inactive), inactive, "noop"), /unrelated|allowlist/);
});
test("MAI disable removes only the selected secret and KMS context", () => {
  const before = fixture(mai);
  const next = fixture();
  for (const row of next.resources) {
    const old = before.resources.find((item) => item.id === row.id);
    if (!old) throw new Error("Fixture row missing");
    row.before = old.after;
    row.action = JSON.stringify(row.before) === JSON.stringify(row.after) ? "noop" : "update";
  }
  next.outputs.before = before.outputs.after;
  verify(next, original, "mai");
});
test("missing seed output and unknown desired properties fail closed", () => {
  const plan = fixture(); plan.outputs.before = null;
  assert.throws(() => verify(plan), /object/);
  const unknown = fixture(); change(unknown, "Function").role = { __unresolved: true };
  assert.throws(() => verify(unknown), /allowlist/);
});
