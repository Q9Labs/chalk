import * as Alchemist from "alchemy/Alchemist";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Cause from "effect/Cause";
import { writeFileSync } from "node:fs";
import { entryFile, requireCutover, selectStack } from "../registry.ts";

const target = requireCutover(selectStack(process.argv[2], process.argv[3]));
const result = await Effect.runPromiseExit(Effect.gen(function* () {
  const stack = yield* Alchemist.importStack(entryFile(target));
  const plan = yield* Alchemist.plan({ stack, stage: target.stage, operation: "deploy" });
  const store = yield* Effect.flatten(State).pipe(Effect.provide(plan.context));
  const previous = yield* store.list({ stack: target.name, stage: target.stage });
  const output = yield* store.getOutput({ stack: target.name, stage: target.stage });
  if (!previous.length || output === undefined) return yield* Effect.die("Deploy refused: missing seeded Alchemy resources/outputs; use the explicit migration procedure");
  yield* Alchemist.apply(plan);
}).pipe(Effect.provide(Alchemist.layer()), Effect.scoped));
if (result._tag === "Failure") {
  const diagnostics = process.env.CHALK_ALCHEMY_DIAGNOSTICS;
  if (diagnostics) writeFileSync(diagnostics, Cause.pretty(result.cause), { mode: 0o600 });
  process.stderr.write("Infrastructure deploy failed; private diagnostics are available only when CHALK_ALCHEMY_DIAGNOSTICS is configured\n");
  process.exitCode = 1;
}
