import * as Alchemist from "alchemy/Alchemist";
import * as Effect from "effect/Effect";
import { checkPlan, type Plan, type Policy } from "./policy.ts";

// The checked object is the applied object. No stdin decisions or replanning.
export const applyCheckedPlan = Effect.fn(function* (native: Alchemist.StackPlan, view: Plan, policy: Policy, apply: boolean) {
  checkPlan(view, policy);
  if (!apply) return false;
  yield* Alchemist.apply(native);
  return true;
});
