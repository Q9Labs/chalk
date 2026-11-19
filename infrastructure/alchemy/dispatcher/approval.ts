import * as Alchemist from "alchemy/Alchemist";
import * as Effect from "effect/Effect";

// The only apply boundary. A rejection (including EOF) is never interpreted as
// approval, and no new plan or stack evaluation can occur here.
export const applyDecision = Effect.fn(function* (plan: Alchemist.StackPlan, decision: string) {
  if (decision !== "approve") return false;
  yield* Alchemist.apply(plan);
  return true;
});
