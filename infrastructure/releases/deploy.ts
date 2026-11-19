import * as Alchemist from "alchemy/Alchemist";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import { entryFile, requireDeployable, selectStack } from "../registry.ts";
import { resourceTypes } from "../transcription-dispatcher/policy.ts";
import { reportFailure } from "./failure.ts";

const { target, stage } = selectStack(process.argv[2], process.argv[3]);
requireDeployable(target);
const result = await Effect.runPromiseExit(Effect.gen(function* () {
  const stack = yield* Alchemist.importStack(entryFile(target));
  const plan = yield* Alchemist.plan({ stack, stage: stage.name, operation: "deploy" });
  const store = yield* Effect.flatten(State).pipe(Effect.provide(plan.context));
  const previous = yield* store.list({ stack: target.stackName, stage: stage.name });
  const output = yield* store.getOutput({ stack: target.stackName, stage: stage.name });
  if (stage.kind === "production" && (!previous.length || output === undefined)) return yield* Effect.die("Deploy refused: missing seeded production resources/outputs");
  if (stage.kind === "ephemeral") {
    if (previous.length || output !== undefined) return yield* Effect.die("Ephemeral stage already exists; use the checked release command or destroy it before retrying bootstrap");
    if (plan.actions.length || Object.keys(plan.native.deletions).length) return yield* Effect.die("Ephemeral bootstrap cannot contain actions or deletions");
    const resources = Object.values(plan.native.resources);
    const expected = Object.entries(resourceTypes).filter(([name]) => name !== "ControlApiPermission");
    if (resources.length !== expected.length || resources.some((row) => row.action !== "create" || !expected.some(([name, type]) => row.resource.FQN === name && row.resource.Type === type))) return yield* Effect.die("Ephemeral bootstrap must create exactly the isolated dispatcher resource set");
  }
  yield* Alchemist.apply(plan);
  process.stdout.write(`${JSON.stringify({ deployed: true, stack: target.stackName, stage: stage.name })}\n`);
}).pipe(Effect.provide(Alchemist.layer()), Effect.scoped));
reportFailure(result, "deploy");
