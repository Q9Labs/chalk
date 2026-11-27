import type { StackPlan } from "alchemy/Alchemist";
import * as Drift from "alchemy/Drift";
import * as Effect from "effect/Effect";
import * as Output from "alchemy/Output";
import { isResolved } from "alchemy/Diff";
import { encodeState } from "alchemy/State/StateEncoding";
import * as Schema from "effect/Schema";
import { isRecoverableReleaseDrift } from "../providers/aws-release-drift.ts";

// Detailed projections stay in-process or in an explicitly requested private
// review file. Public summaries contain only logical IDs and actions.
export const jsonValue = (value: unknown): Schema.MutableJson => Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(JSON.stringify(encodeState(value)));

export const blockingDrift = (_id: string, row: { readonly action: string; readonly resourceType?: string; readonly attr?: unknown }, node: { readonly state?: unknown } | undefined, allowRecoverableInterruptedUpdate = false) => {
  if (row.action === "unchanged") return false;
  const state = node?.state;
  const persisted = state !== null && typeof state === "object" && "attr" in state ? state.attr : undefined;
  const status = state !== null && typeof state === "object" && "status" in state ? state.status : undefined;
  const isLambda = row.resourceType === "Chalk.Lambda.VersionedFunction";
  const interruptedUpdateCase = isLambda && row.action === "skipped" && status === "updating";
  const driftCase = isLambda && row.action === "drifted" && isRecoverableReleaseDrift(persisted, row.attr);
  const recoverable = allowRecoverableInterruptedUpdate && (interruptedUpdateCase || driftCase);
  return !recoverable;
};

export const planView = Effect.fn(function* (plan: StackPlan, beforeOutput: unknown, options: { readonly allowRecoverableInterruptedUpdate?: boolean } = {}) {
  const allowRecoverableInterruptedUpdate = options.allowRecoverableInterruptedUpdate === true;
  const drift = yield* Drift.detect(plan.stack);
  const nodesById = new Map(Object.values(plan.native.resources).map((node) => [node.resource.FQN, node] as const));
  const drifted = Object.entries(drift.resources).filter(([id, row]) => blockingDrift(id, row, nodesById.get(id), allowRecoverableInterruptedUpdate));
  if (drifted.length) throw new Error(`Dispatcher live drift must be resolved before release planning: ${drifted.map(([id, row]) => `${id} (${row.action})`).join(", ")}`);
  if (plan.actions.length) throw new Error("Dispatcher plans may not contain Actions");
  const nodes = [...Object.values(plan.native.resources), ...Object.values(plan.native.deletions).filter((node) => node !== undefined)];
  const stableAttrs = Object.fromEntries(
    nodes.map((node) => {
      if (!node.state) throw new Error("Dispatcher resource has no stable completed Alchemy state");
      const state = node.state;
      const stable = state.status === "created" || state.status === "updated" || (allowRecoverableInterruptedUpdate && state.status === "updating" && state.resourceType === "Chalk.Lambda.VersionedFunction");
      if (!stable) throw new Error("Dispatcher resource has no stable completed Alchemy state");
      const attr = state.attr;
      if (!attr) throw new Error("Dispatcher state has no completed attributes");
      return [node.resource.FQN, Object.fromEntries((node.provider.stables ?? []).map((key) => [key, attr[key]]))];
    }),
  );
  const resources = yield* Effect.forEach(nodes, (node) =>
    Effect.gen(function* () {
      if (node.bindings.some((binding) => binding.action !== "noop")) throw new Error("Dispatcher plan contains binding mutations");
      const before = node.state && "props" in node.state ? (allowRecoverableInterruptedUpdate && node.state.status === "updating" && "old" in node.state && node.state.old && typeof node.state.old === "object" && "props" in node.state.old ? node.state.old.props : node.state.props) : null;
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
