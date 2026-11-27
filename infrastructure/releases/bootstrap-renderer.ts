import * as Alchemist from "alchemy/Alchemist";
import * as NativePlan from "alchemy/Plan";
import { Stack } from "alchemy/Stack";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import { readFileSync } from "node:fs";
import { entryFile, selectStack } from "../registry.ts";
import { reportFailure } from "./failure.ts";

const expectedTypes: Record<string, string> = {
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

export type BootstrapResourceRow = { readonly action: string; readonly resource: { readonly FQN: string; readonly Type: string } };

export function validateBootstrapResources(resources: readonly BootstrapResourceRow[], resumed: boolean): void {
  const names = resources.map((row) => row.resource.FQN).sort();
  const required = Object.keys(expectedTypes)
    .filter((name) => name !== "ControlApiPermission" && name !== "ControlApiInvokePolicy")
    .sort();
  const allowed = Object.keys(expectedTypes).sort();
  if (names.some((name) => !allowed.includes(name)) || required.some((name) => !names.includes(name))) throw new Error(`Production renderer bootstrap resource set must be ${required.join(",")} plus the optional invoke permission/policy`);
  const actions = resumed ? ["create", "noop", "update"] : ["create"];
  if (resources.some((row) => !actions.includes(row.action) || row.resource.Type !== expectedTypes[row.resource.FQN])) {
    throw new Error(resumed ? "Production renderer bootstrap resume may only create missing resources or finish/update interrupted resources" : "Production renderer bootstrap must be a complete create-only plan");
  }
}

export function bootstrapInputsMatchCheckpoint(
  resources: readonly unknown[],
  input: {
    readonly release_id?: unknown;
    readonly release_manifest_digest?: unknown;
    readonly config_digest?: unknown;
    readonly artifact_s3_bucket?: unknown;
    readonly artifact_s3_key?: unknown;
    readonly artifact_s3_object_version?: unknown;
    readonly artifact_sha256_base64?: unknown;
  },
): boolean {
  const fn = resources.find((row) => {
    const resource = row as { resource?: { FQN?: string }; state?: { status?: string } };
    return resource.resource?.FQN === "Function" && ["creating", "created", "updating", "updated"].includes(resource.state?.status ?? "");
  }) as { state?: { props?: { tags?: Record<string, unknown>; code?: { bucket?: unknown; key?: unknown; version?: unknown; sha256?: unknown } } } } | undefined;
  if (!fn?.state?.props) return true;
  const props = fn.state.props;
  return (
    props.tags?.chalk_release_id === input.release_id &&
    props.tags?.chalk_release_manifest_digest === input.release_manifest_digest &&
    props.tags?.chalk_config_digest === input.config_digest &&
    props.code?.bucket === input.artifact_s3_bucket &&
    props.code?.key === input.artifact_s3_key &&
    props.code?.version === input.artifact_s3_object_version &&
    props.code?.sha256 === input.artifact_sha256_base64
  );
}

const main = Effect.gen(function* () {
  const { target, stage } = selectStack(process.argv[2], process.argv[3]);
  if (target.stackName !== "document-renderer" || stage.kind !== "production") return yield* Effect.die("Only document-renderer production has a bootstrap command");
  if (process.env.CHALK_DOCUMENT_RENDERER_PRODUCTION_BOOTSTRAP !== "approved") return yield* Effect.die("Production renderer bootstrap requires explicit CHALK_DOCUMENT_RENDERER_PRODUCTION_BOOTSTRAP=approved");
  const stack = yield* Alchemist.importStack(entryFile(target));
  const plan = yield* Alchemist.plan({ stack, stage: stage.name, operation: "deploy" });
  const store = yield* Effect.flatten(State).pipe(Effect.provide(plan.context));
  const identity = { stack: plan.stack.name, stage: plan.stack.stage };
  if ((yield* store.getOutput(identity)) !== undefined) return yield* Effect.die("Production renderer bootstrap is complete; use releases/renderer-driver.ts for renderer changes");
  const resumed = (yield* store.list(identity)).length > 0;
  if (plan.actions.length || Object.keys(plan.native.deletions).length) return yield* Effect.die("Production renderer bootstrap cannot contain actions or deletions");
  const resources = Object.values(plan.native.resources);
  const inputFile = process.env.CHALK_INFRA_INPUTS;
  if (resumed && inputFile && !bootstrapInputsMatchCheckpoint(resources, JSON.parse(readFileSync(inputFile, "utf8")))) return yield* Effect.die("Production renderer bootstrap inputs do not match the interrupted checkpoint; restore the original inputs or resolve state explicitly");
  const validation = Effect.try(() => validateBootstrapResources(resources, resumed));
  yield* validation;
  yield* Alchemist.apply(plan);
  const declared = yield* Stack.pipe(Effect.provide(plan.context));
  const second = yield* NativePlan.make({ ...declared, output: plan.native.output }).pipe(Effect.provide(plan.context));
  if (Object.keys(second.deletions).length || Object.values(second.resources).some((row) => row.action !== "noop")) return yield* Effect.die("Production renderer bootstrap did not converge; state saved, no retry without review");
  process.stdout.write(`${JSON.stringify({ bootstrapped: true, resumed, stack: target.stackName, stage: stage.name })}\n`);
});

if (import.meta.main) {
  const result = await Effect.runPromiseExit(main.pipe(Effect.provide(Alchemist.layer()), Effect.scoped));
  reportFailure(result, "bootstrap");
}
