import * as Alchemist from "alchemy/Alchemist";
import { clearStage } from "./cleanup.ts";
import * as Effect from "effect/Effect";
import { entryFile, selectStack } from "../registry.ts";
import { resourceTypes } from "../transcription-dispatcher/policy.ts";
import { reportFailure } from "./failure.ts";

const { target, stage } = selectStack(process.argv[2], process.argv[3]);
if (stage.kind !== "ephemeral") throw new Error("Destroy refuses persistent production and retired legacy stages");
const result = await Effect.runPromiseExit(Effect.gen(function* () {
  const stack = yield* Alchemist.importStack(entryFile(target));
  const plan = yield* Alchemist.plan({ stack, stage: stage.name, operation: "destroy" });
  for (const row of Object.values(plan.native.deletions)) {
    if (row && !Object.entries(resourceTypes).some(([name, type]) => row.resource.FQN === name && row.resource.Type === type)) return yield* Effect.die("Destroy refuses unexpected resource state");
  }
  yield* clearStage(plan);
  process.stdout.write(`${JSON.stringify({ destroyed: true, state_empty: true, stack: target.stackName, stage: stage.name })}\n`);
}).pipe(Effect.provide(Alchemist.layer()), Effect.scoped));
reportFailure(result, "destroy");
