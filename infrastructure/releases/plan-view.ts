import type { StackPlan } from "alchemy/Alchemist";
import * as Effect from "effect/Effect";
import * as Output from "alchemy/Output";
import { isResolved } from "alchemy/Diff";
import { encodeState } from "alchemy/State/StateEncoding";
import * as Schema from "effect/Schema";

// Only the private parent/child pipe receives values. Human summaries contain
// logical IDs and actions only; never serialize a provider's live attributes.
export const jsonValue = (value: unknown): Schema.MutableJson => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(JSON.stringify(encodeState(value)));
export const planView = Effect.fn(function* (plan: StackPlan, beforeOutput: unknown) {
  if (plan.actions.length) throw new Error("Dispatcher plans may not contain Actions");
  const nodes = [...Object.values(plan.native.resources), ...Object.values(plan.native.deletions).filter((node) => node !== undefined)];
  const stableAttrs = Object.fromEntries(
    nodes.map((node) => {
      if (!node.state || !("attr" in node.state)) throw new Error("Dispatcher resource has no completed Alchemy state");
      const attr = node.state.attr;
      if (!attr) throw new Error("Dispatcher state has no completed attributes");
      return [node.resource.FQN, Object.fromEntries((node.provider.stables ?? []).map((key) => [key, attr[key]]))];
    }),
  );
  const resources = yield* Effect.forEach(nodes, (node) =>
    Effect.gen(function* () {
      if (node.bindings.some((binding) => binding.action !== "noop")) throw new Error("Dispatcher plan contains binding mutations");
      const before = node.state && "props" in node.state ? node.state.props : null;
      const proposed = "props" in node ? node.props : node.action === "noop" ? before : null;
      // Only stable upstream identities may be resolved for approval. A mutable
      // value that could change during apply cannot enter the checked projection.
      const after = yield* Output.evaluateAvailable(proposed, stableAttrs);
      if (!isResolved(after)) throw new Error("Dispatcher plan contains unknown desired properties");
      return { id: node.resource.FQN, type: node.resource.Type, action: node.action, before: jsonValue(before), after: jsonValue(after) };
    }),
  );
  return { resources, outputs: { before: jsonValue(beforeOutput), after: jsonValue(plan.native.output) } };
});
