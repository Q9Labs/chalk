import type { DocumentRendererInputs } from "./config.ts";
import { plainPlan, type Patch, type Plan, type Policy } from "../releases/policy.ts";
import type * as Schema from "effect/Schema";

export const resourceTypes = {
  ExecutionRole: "AWS.IAM.Role",
  Logs: "AWS.Logs.LogGroup",
  FailureLogMetric: "AWS.Logs.MetricFilter",
  Function: "Chalk.Lambda.VersionedFunction",
  ControlApiPermission: "AWS.Lambda.Permission",
  ControlApiInvokePolicy: "Chalk.IAM.RoleInlinePolicy",
  Errors: "AWS.CloudWatch.Alarm",
  Throttles: "AWS.CloudWatch.Alarm",
  AsyncEventsDropped: "AWS.CloudWatch.Alarm",
};
export type Operation = "noop" | "release";
const set = (path: readonly string[], value: Schema.MutableJson): Patch => ({ path, value });

export function rendererPolicy(raw: Plan, input: DocumentRendererInputs, operation: Operation): { plan: Plan; policy: Policy } {
  const plan = plainPlan(raw);
  const edits = new Map<string, readonly Patch[]>();
  let outputs: readonly string[] = [],
    inputs: readonly string[] = [];
  if (operation === "release") {
    const functionEdits = [
      set(["tags", "chalk_release_id"], input.release_id),
      set(["description"], `Presenting document renderer (${input.release_id})`),
      set(["code", "key"], input.artifact_s3_key),
      set(["code", "version"], input.artifact_s3_object_version),
      set(["environment", "CHALK_RELEASE_ID"], input.release_id),
      set(["environment", "CHALK_CONFIG_DIGEST"], input.config_digest),
      set(["tags", "chalk_config_digest"], input.config_digest),
      set(["code", "sha256"], input.artifact_sha256_base64),
      set(["environment", "CHALK_RELEASE_MANIFEST_DIGEST"], input.release_manifest_digest),
      set(["tags", "chalk_release_manifest_digest"], input.release_manifest_digest),
    ];
    edits.set("Function", functionEdits);
    edits.set("Logs", [set(["tags", "chalk_release_id"], input.release_id)]);
    outputs = ["artifact_identity", "release_identity"];
    inputs = ["release_id", "artifact_s3_key", "artifact_s3_object_version", "config_digest", "release_manifest_digest", "artifact_s3_bucket", "artifact_sha256", "artifact_sha256_base64"];
  }
  return {
    plan,
    policy: {
      resources: Object.entries(resourceTypes).map(([id, type]) => ({ id, type, required: id !== "ControlApiPermission" && id !== "ControlApiInvokePolicy", patches: edits.get(id) ?? [] })),
      outputs,
      inputs,
      inputsOutputName: "renderer_inputs",
      requestedInputs: input,
      allowRecoverableInterruptedUpdate: true,
    },
  };
}
