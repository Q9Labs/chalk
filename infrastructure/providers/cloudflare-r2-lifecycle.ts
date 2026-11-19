import * as r2 from "@distilled.cloud/cloudflare/r2";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const age = Schema.Struct({ type: Schema.Literal("Age"), maxAge: Schema.Number });
const condition = Schema.Union([age, Schema.Struct({ type: Schema.Literal("Date"), date: Schema.String })]);
const rule = Schema.Struct({
  id: Schema.String,
  conditions: Schema.Struct({ prefix: Schema.String }),
  enabled: Schema.Boolean,
  abortMultipartUploadsTransition: Schema.optional(Schema.Struct({ condition: Schema.optional(age) })),
  deleteObjectsTransition: Schema.optional(Schema.Struct({ condition: Schema.optional(condition) })),
  storageClassTransitions: Schema.optional(Schema.Array(Schema.Struct({ condition, storageClass: Schema.String })).pipe(Schema.mutable)),
});
type LifecycleRule = typeof rule.Type;

// The read API uses null for missing fields; PUT uses omission. Reject unknown fields rather than lose rules.
const omitNulls = (value: Schema.Json): Schema.Json => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(omitNulls);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== null)
      .map(([key, child]) => [key, omitNulls(child)]),
  );
};
export const normalizeRules = (value: unknown): LifecycleRule[] => [...Schema.decodeUnknownSync(Schema.Array(rule), { onExcessProperty: "error" })(omitNulls(Schema.decodeUnknownSync(Schema.Json)(value)))];
const canonicalRules = (rules: readonly LifecycleRule[]) =>
  normalizeRules(rules)
    .map((rule) => ({ ...rule, storageClassTransitions: rule.storageClassTransitions ?? [] }))
    .sort((left, right) => left.id.localeCompare(right.id));

interface R2Lifecycle extends Resource<"Chalk.R2.Lifecycle", { accountId: string; bucketName: string; rules: readonly LifecycleRule[]; finalizedPrefix: string }, { accountId: string; bucketName: string; rules: readonly LifecycleRule[] }> {}
export const R2Lifecycle = Resource<R2Lifecycle>("Chalk.R2.Lifecycle");

export function replaceLifecycleRules(current: readonly LifecycleRule[], managedIds: readonly string[], desired: readonly LifecycleRule[]): LifecycleRule[] {
  return canonicalRules([...current.filter((rule) => !managedIds.includes(rule.id)), ...desired]);
}

export function validateLifecycleRules(rules: readonly LifecycleRule[], finalizedPrefix: string): void {
  if (!rules.length || new Set(rules.map((rule) => rule.id)).size !== rules.length) throw new Error("Lifecycle rules must be nonempty and have unique IDs.");
  for (const rule of rules) {
    const prefix = rule.conditions.prefix;
    if (!prefix || prefix.startsWith("/") || finalizedPrefix.startsWith(prefix)) throw new Error("Temporary lifecycle prefixes must be relative and must not contain the finalized transcript prefix; committed deletion is application-owned.");
    if ([!rule.enabled, rule.deleteObjectsTransition?.condition?.type !== "Age" || rule.deleteObjectsTransition.condition.maxAge !== 86400, rule.abortMultipartUploadsTransition?.condition?.maxAge !== 86400, rule.storageClassTransitions?.length].some(Boolean))
      throw new Error("Temporary transcription rules must delete objects and abort multipart uploads after exactly 24 hours, with no storage class transition.");
  }
}

const readRules = Effect.fn(function* (accountId: string, bucketName: string) {
  const observed = yield* r2.getBucketLifecycle({ accountId, bucketName });
  return normalizeRules(observed.rules ?? []);
});

export const r2LifecycleProvider = Provider.succeed(R2Lifecycle, {
  stables: ["accountId", "bucketName"],
  list: () => Effect.succeed([]),
  read: Effect.fn(function* ({ olds, output }) {
    const props = output ?? olds;
    const rules = yield* readRules(props.accountId, props.bucketName);
    const ids = props.rules.map((rule) => rule.id);
    const owned = canonicalRules(rules.filter((rule) => ids.includes(rule.id)));
    return owned.length ? { accountId: props.accountId, bucketName: props.bucketName, rules: owned } : undefined;
  }),
  diff: Effect.fn(function* ({ olds, news, output }) {
    if (!isResolved(news)) return;
    if (olds.accountId !== news.accountId || olds.bucketName !== news.bucketName) return { action: "replace" };
    if (output && !deepEqual(canonicalRules(output.rules), canonicalRules(news.rules))) return { action: "update" };
  }),
  reconcile: Effect.fn(function* ({ news, olds }) {
    validateLifecycleRules(news.rules, news.finalizedPrefix);
    const current = yield* readRules(news.accountId, news.bucketName);
    const managedIds = [...(olds?.rules ?? []), ...news.rules].map((rule) => rule.id);
    const rules = replaceLifecycleRules(current, managedIds, news.rules);
    if (!deepEqual(canonicalRules(current), rules)) yield* r2.putBucketLifecycle({ accountId: news.accountId, bucketName: news.bucketName, rules: normalizeRules(rules) });
    return { accountId: news.accountId, bucketName: news.bucketName, rules: canonicalRules(news.rules) };
  }),
  delete: Effect.fn(function* ({ output }) {
    const current = yield* readRules(output.accountId, output.bucketName);
    const rules = replaceLifecycleRules(
      current,
      output.rules.map((rule) => rule.id),
      [],
    );
    if (!deepEqual(canonicalRules(current), rules)) yield* r2.putBucketLifecycle({ accountId: output.accountId, bucketName: output.bucketName, rules: normalizeRules(rules) });
  }),
});
