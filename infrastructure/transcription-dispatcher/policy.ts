import type * as Schema from "effect/Schema";
import { at, object, plainPlan, type Patch, type Plan, type Policy } from "../releases/policy.ts";
import type { DispatcherInputs } from "./config.ts";

export const resourceTypes = {
  ExecutionRole: "AWS.IAM.Role",
  SchedulerRole: "AWS.IAM.Role",
  AsyncFailure: "AWS.SQS.Queue",
  SchedulerDlq: "AWS.SQS.Queue",
  Logs: "AWS.Logs.LogGroup",
  Function: "Chalk.Lambda.VersionedFunction",
  Reconcile: "AWS.Scheduler.Schedule",
  SchedulerPermission: "AWS.Lambda.Permission",
  ControlApiPermission: "AWS.Lambda.Permission",
  Errors: "AWS.CloudWatch.Alarm",
  Throttles: "AWS.CloudWatch.Alarm",
  AsyncEventsDropped: "AWS.CloudWatch.Alarm",
  AsyncFailureDepth: "AWS.CloudWatch.Alarm",
  SchedulerTargetErrors: "AWS.CloudWatch.Alarm",
};
export type Operation = "noop" | "binding" | "release" | "mai";
const set = (path: readonly string[], value: Schema.MutableJson): Patch => ({ path, value });
function strings(value: Schema.MutableJson): string[] {
  const list = Array.isArray(value) ? value : [value];
  if (!list.every((item): item is string => typeof item === "string")) throw new Error("Expected IAM string values");
  return [...list].sort();
}
function statements(value: Schema.MutableJson) {
  const result = object(value).Statement;
  if (!Array.isArray(result)) throw new Error("Expected IAM statements");
  return result.map(object);
}
function canonicalPolicy(value: Schema.MutableJson): Schema.MutableJson {
  const result = structuredClone(value);
  for (const statement of statements(result)) {
    for (const key of ["Resource", "Action"]) if (statement[key] !== undefined) statement[key] = strings(statement[key]);
    const condition = statement.Condition;
    if (condition && object(condition).StringEquals) {
      const equals = object(object(condition).StringEquals);
      const key = "kms:EncryptionContext:PARAMETER_ARN";
      if (equals[key] !== undefined) equals[key] = strings(equals[key]);
    }
  }
  object(result).Statement = statements(result).sort((a, b) => String(a.Sid ?? "").localeCompare(String(b.Sid ?? "")));
  return result;
}
function secretPolicy(value: Schema.MutableJson, arn: string, enabled: boolean): Schema.MutableJson {
  const result = structuredClone(value);
  let matched = false;
  const update = (value: Schema.MutableJson) => {
    const values = new Set(strings(value));
    if (enabled) values.add(arn);
    else values.delete(arn);
    return [...values].sort();
  };
  for (const statement of statements(result)) {
    if (statement.Sid === "ReadOnlyTranscriptionAndApiSecrets") {
      statement.Resource = update(at(statement, ["Resource"]));
      matched = true;
    }
    if (statement.Condition && object(statement.Condition).StringEquals) {
      const equals = object(object(statement.Condition).StringEquals);
      const key = "kms:EncryptionContext:PARAMETER_ARN";
      if (equals[key] !== undefined) equals[key] = update(equals[key]);
    }
  }
  if (!matched) throw new Error("Dispatcher secret-read policy is missing");
  return canonicalPolicy(result);
}
export function dispatcherPolicy(raw: Plan, input: DispatcherInputs, operation: Operation): { plan: Plan; policy: Policy } {
  const plan = plainPlan(raw);
  const edits = new Map<string, readonly Patch[]>();
  let outputs: readonly string[] = [],
    inputs: readonly string[] = [];
  if (operation === "binding" || operation === "release") {
    const functionEdits = [
      set(["tags", "chalk_release_id"], input.release_id),
      set(["description"], `Track-aware transcription dispatcher (${input.release_id})`),
      set(["code", "key"], input.artifact_s3_key),
      set(["code", "version"], input.artifact_s3_object_version),
      set(["environment", "CHALK_RELEASE_ID"], input.release_id),
      set(["environment", "CHALK_CONFIG_DIGEST"], input.config_digest),
      set(["tags", "chalk_config_digest"], input.config_digest),
    ];
    inputs = ["release_id", "artifact_s3_key", "artifact_s3_object_version", "config_digest"];
    if (operation === "release") {
      functionEdits.push(
        set(["code", "sha256"], input.artifact_sha256_base64),
        set(["environment", "CHALK_RELEASE_MANIFEST_DIGEST"], input.release_manifest_digest),
        set(["environment", "DEEPINFRA_CORPUS_DIGEST"], input.deepinfra_corpus_digest),
        set(["tags", "chalk_release_manifest_digest"], input.release_manifest_digest),
      );
      edits.set("Reconcile", [set(["state"], input.environment_name === "production" ? "ENABLED" : "DISABLED")]);
      inputs = [...inputs, "release_manifest_digest", "artifact_s3_bucket", "artifact_sha256", "artifact_sha256_base64", "scheduler_state", "deepinfra_corpus_digest"];
    }
    edits.set("Function", functionEdits);
    edits.set("Logs", [set(["tags", "chalk_release_id"], input.release_id)]);
    outputs = ["artifact_identity", "release_identity"];
  }
  if (operation === "mai") {
    const enabled = input.codeswitch_provider === "mai";
    const previous = at(plan.outputs.before, ["dispatcher_inputs"]);
    const arn = input.openrouter_token_parameter_arn || at(previous, ["openrouter_token_parameter_arn"]);
    if (typeof arn !== "string" || !new RegExp(`^arn:aws:ssm:[a-z0-9-]+:\\d{12}:parameter/chalk/${input.environment_name}/[A-Za-z0-9_.\\-/]+$`).test(arn)) throw new Error("MAI requires an environment-scoped secret ARN");
    for (const row of plan.resources) {
      if (row.id === "ExecutionRole") {
        for (const side of [row.before, row.after]) {
          const policies = object(at(side, ["inlinePolicies"]));
          if (Object.keys(policies).length !== 1) throw new Error("Dispatcher execution role has unexpected inline policies");
          for (const [name, policy] of Object.entries(policies)) policies[name] = canonicalPolicy(policy);
        }
        const policies = object(at(row.before, ["inlinePolicies"]));
        edits.set(
          "ExecutionRole",
          Object.entries(policies).map(([name, policy]) => set(["inlinePolicies", name], secretPolicy(policy, arn, enabled))),
        );
      }
      if (row.id === "Function") {
        const env = object(structuredClone(at(row.before, ["environment"])));
        delete env.CODESWITCH_PROVIDER;
        delete env.OPENROUTER_TOKEN_PARAMETER_ARN;
        if (enabled) {
          env.CODESWITCH_PROVIDER = "mai";
          env.OPENROUTER_TOKEN_PARAMETER_ARN = arn;
        }
        env.CHALK_CONFIG_DIGEST = input.config_digest;
        edits.set("Function", [set(["environment"], env), set(["tags", "chalk_config_digest"], input.config_digest)]);
      }
    }
    outputs = ["required_egress_destinations", "release_identity"];
    inputs = ["codeswitch_provider", "openrouter_token_parameter_arn", "config_digest"];
  }
  return { plan, policy: { resources: Object.entries(resourceTypes).map(([id, type]) => ({ id, type, required: id !== "ControlApiPermission", patches: edits.get(id) ?? [] })), outputs, inputs, requestedInputs: input } };
}
