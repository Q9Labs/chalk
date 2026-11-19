import * as Alchemist from "alchemy/Alchemist";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import { entryFile, requireDeployable, selectStack } from "../registry.ts";
import { resourceTypes } from "../transcription-dispatcher/policy.ts";
import { reportFailure } from "./failure.ts";

export const checkBootstrap = Effect.fn(function* (plan: Alchemist.StackPlan) {
  const store = yield* Effect.flatten(State).pipe(Effect.provide(plan.context));
  const identity = { stack: plan.stack.name, stage: plan.stack.stage };
  if ((yield* store.list(identity)).length || (yield* store.getOutput(identity)) !== undefined) return yield* Effect.die("Ephemeral stage already exists; refusing to claim or clean up another run");
  if (plan.actions.length || Object.keys(plan.native.deletions).length) return yield* Effect.die("Ephemeral bootstrap cannot contain actions or deletions");
  const resources = Object.values(plan.native.resources);
  const expected = Object.entries(resourceTypes).filter(([name]) => name !== "ControlApiPermission");
  if (resources.length !== expected.length || resources.some((row) => row.action !== "create" || !expected.some(([name, type]) => row.resource.FQN === name && row.resource.Type === type))) return yield* Effect.die("Ephemeral bootstrap must create exactly the isolated dispatcher resource set");
});

export const prepareDeployment = Effect.fn(function* (name: string | undefined, stageName: string | undefined) {
  const { target, stage } = selectStack(name, stageName);
  requireDeployable(target);
  const stack = yield* Alchemist.importStack(entryFile(target));
  const plan = yield* Alchemist.plan({ stack, stage: stage.name, operation: "deploy" });
  if (stage.kind === "ephemeral") yield* checkBootstrap(plan);
  else {
    const store = yield* Effect.flatten(State).pipe(Effect.provide(plan.context));
    const identity = { stack: target.stackName, stage: stage.name };
    if (!(yield* store.list(identity)).length || (yield* store.getOutput(identity)) === undefined) return yield* Effect.die("Deploy refused: missing seeded production resources/outputs");
  }
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
