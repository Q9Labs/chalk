import * as Alchemist from "alchemy/Alchemist";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";

export const clearStage = Effect.fn(function* (plan: Alchemist.StackPlan) {
  if (Object.values(plan.native.deletions).some((row) => row?.action === "orphaned")) return yield* Effect.die("Cleanup refuses retained resources; their physical resources and state must not be silently orphaned");
  yield* Alchemist.apply(plan);
  const store = yield* Effect.flatten(State).pipe(Effect.provide(plan.context));
  const identity = { stack: plan.stack.name, stage: plan.stack.stage };
  if ((yield* store.list(identity)).length) return yield* Effect.die("Cleanup left resources; refusing to forget their state");
  yield* store.deleteStack(identity);
  if ((yield* store.list(identity)).length || (yield* store.getOutput(identity)) !== undefined) return yield* Effect.die("Cleanup left stage state");
});
