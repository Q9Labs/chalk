import * as Alchemist from "alchemy/Alchemist";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import { entryFile, requireDeployable, selectStack } from "../registry.ts";
import { resourceTypes } from "../transcription-dispatcher/policy.ts";
import { reportFailure } from "./failure.ts";

export interface BootstrapRow {
  readonly action: string;
  readonly resource: { readonly FQN: string; readonly Type: string };
}

// The renderer lists its own types; ControlApiPermission is optional, every other type is required.
export const bootstrapMatches = (stackName: string, rows: ReadonlyArray<BootstrapRow>) => {
  const types = new Map(
    Object.entries(
      stackName === "document-renderer" || stackName === "document-renderer-image"
        ? {
            ExecutionRole: "AWS.IAM.Role",
            Logs: "AWS.Logs.LogGroup",
            FailureLogMetric: "AWS.Logs.MetricFilter",
            Function: "Chalk.Lambda.VersionedFunction",
            Errors: "AWS.CloudWatch.Alarm",
            Throttles: "AWS.CloudWatch.Alarm",
            AsyncEventsDropped: "AWS.CloudWatch.Alarm",
            ControlApiPermission: "AWS.Lambda.Permission",
          }
        : resourceTypes,
    ),
  );
  const created = new Map(rows.map((row) => [row.resource.FQN, row]));
  const requiredPresent = [...types.keys()].filter((name) => name !== "ControlApiPermission").every((name) => created.has(name));
  const allExpected = rows.every((row) => row.action === "create" && types.get(row.resource.FQN) === row.resource.Type);
  return requiredPresent && allExpected;
};

export const checkBootstrap = Effect.fn(function* (plan: Alchemist.StackPlan) {
  const store = yield* Effect.flatten(State).pipe(Effect.provide(plan.context));
  const identity = { stack: plan.stack.name, stage: plan.stack.stage };
  if ((yield* store.list(identity)).length || (yield* store.getOutput(identity)) !== undefined) return yield* Effect.die("Ephemeral stage already exists; refusing to claim or clean up another run");
  if (plan.actions.length || Object.keys(plan.native.deletions).length) return yield* Effect.die("Ephemeral bootstrap cannot contain actions or deletions");
  const resources = Object.values(plan.native.resources);
  if (!bootstrapMatches(plan.stack.name, resources)) return yield* Effect.die("Ephemeral bootstrap must create exactly the isolated workload resource set");
});

export const requireSeededState = Effect.fn(function* (plan: Alchemist.StackPlan) {
  const store = yield* Effect.flatten(State).pipe(Effect.provide(plan.context));
  const identity = { stack: plan.stack.name, stage: plan.stack.stage };
  if (!(yield* store.list(identity)).length || (yield* store.getOutput(identity)) === undefined) return yield* Effect.die("Deploy refused: missing seeded production resources/outputs");
});

export const prepareDeployment = Effect.fn(function* (name: string | undefined, stageName: string | undefined) {
  const { target, stage } = selectStack(name, stageName);
  requireDeployable(target);
  if ((target.stackName === "document-renderer" || target.stackName === "document-renderer-image") && stage.kind !== "ephemeral") return yield* Effect.die("Production renderer releases go through releases/renderer-driver.ts, not the generic deploy");
  const stack = yield* Alchemist.importStack(entryFile(target));
  const plan = yield* Alchemist.plan({ stack, stage: stage.name, operation: "deploy" });
  if (stage.kind === "ephemeral") yield* checkBootstrap(plan);
  else yield* requireSeededState(plan);
  return { plan, target, stage };
});

if (import.meta.main) {
  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const { plan, target, stage } = yield* prepareDeployment(process.argv[2], process.argv[3]);
      yield* Alchemist.apply(plan);
      process.stdout.write(`${JSON.stringify({ deployed: true, stack: target.stackName, stage: stage.name })}\n`);
    }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
  );
  reportFailure(result, "deploy");
}
