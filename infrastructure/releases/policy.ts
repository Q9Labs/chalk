import { isDeepStrictEqual } from "node:util";
import * as Schema from "effect/Schema";

export const planSchema = Schema.Struct({
  resources: Schema.Array(Schema.Struct({ id: Schema.String, type: Schema.String, action: Schema.String, before: Schema.MutableJson, after: Schema.MutableJson })),
  outputs: Schema.Struct({ before: Schema.MutableJson, after: Schema.MutableJson }),
});
export type Plan = typeof planSchema.Type;
export type Patch = { readonly path: readonly string[]; readonly value: Schema.MutableJson };
export type Policy = {
  readonly resources: readonly { readonly id: string; readonly type: string; readonly required: boolean; readonly patches: readonly Patch[] }[];
  readonly outputs: readonly string[];
  readonly inputs: readonly string[];
  readonly requestedInputs: Schema.Json;
};
export function object(value: Schema.MutableJson | undefined) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Plan property must be a completely known object");
  return value;
}
export function unredact(value: Schema.MutableJson): Schema.MutableJson {
  if (Array.isArray(value)) return value.map(unredact);
  if (value !== null && typeof value === "object") {
    if (Object.keys(value).length === 1 && "__redacted__" in value) return unredact(value.__redacted__);
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, unredact(child)]));
  }
  return value;
}
export const plainPlan = (plan: Plan) => ({ resources: plan.resources.map((row) => ({ ...row, before: unredact(row.before), after: unredact(row.after) })), outputs: { before: unredact(plan.outputs.before), after: unredact(plan.outputs.after) } });
export function at(value: Schema.MutableJson, path: readonly string[]): Schema.MutableJson {
  let current = value;
  for (const key of path) {
    const next = object(current)[key];
    if (next === undefined) throw new Error("Required plan property missing");
    current = next;
  }
  return current;
}
function patch(value: Schema.MutableJson, edit: Patch) {
  const keys = [...edit.path];
  const key = keys.pop();
  if (!key) throw new Error("Policy patches need a property path");
  object(at(value, keys))[key] = structuredClone(edit.value);
}
function equalExcept(before: Schema.MutableJson, after: Schema.MutableJson, allowed: readonly string[], label: string) {
  const left = object(before), right = object(after);
  if (!isDeepStrictEqual(Object.keys(left).sort(), Object.keys(right).sort())) throw new Error(`${label} names changed`);
  for (const key of Object.keys(left)) {
    if (!allowed.includes(key) && !isDeepStrictEqual(left[key], right[key])) throw new Error(`${label} changes unrelated values`);
  }
}
export function checkPlan(plan: Plan, policy: Policy): void {
  const seen = new Set<string>();
  for (const row of plan.resources) {
    const rule = policy.resources.find((rule) => rule.id === row.id);
    if (!rule || seen.has(row.id) || row.type !== rule.type) throw new Error("Plan contains an unexpected resource");
    seen.add(row.id);
    if (row.action !== "noop" && row.action !== "update") throw new Error("Plan must not create, adopt, delete or replace resources");
    object(row.before); object(row.after);
    const expected = structuredClone(row.before);
    if (row.action === "update") {
      if (!rule.patches.length) throw new Error("Plan exceeds resource allowlist");
      for (const edit of rule.patches) patch(expected, edit);
    }
    if (!isDeepStrictEqual(expected, row.after)) throw new Error("Plan changes a property outside the allowlist");
  }
  if (policy.resources.some((rule) => rule.required && !seen.has(rule.id))) throw new Error("Plan is partial; full-stack checks are required");
  equalExcept(plan.outputs.before, plan.outputs.after, [...policy.outputs, "dispatcher_inputs"], "Output");
  const beforeInputs = at(plan.outputs.before, ["dispatcher_inputs"]);
  const afterInputs = at(plan.outputs.after, ["dispatcher_inputs"]);
  if (!isDeepStrictEqual(afterInputs, policy.requestedInputs)) throw new Error("Planned inputs differ from requested configuration");
  equalExcept(beforeInputs, afterInputs, policy.inputs, "Input");
}
