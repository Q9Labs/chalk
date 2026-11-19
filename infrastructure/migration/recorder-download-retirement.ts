import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import type { ConfiguredStack } from "alchemy/Stack";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { providers } from "../platform/config.ts";
import { BucketPolicy, readPolicy } from "../providers/aws-bucket-policy.ts";
import { object } from "../releases/policy.ts";

// The bucket is shared. Retirement removes the CDN grant, never its TLS deny
// or unrelated statements, and never deletes the bucket or any objects.
export function removeDownloadGrant(document: Schema.MutableJson): Schema.MutableJson {
  const result = structuredClone(document);
  const policy = object(result);
  if (!Array.isArray(policy.Statement)) throw new Error("Bucket policy has no statement list; retirement refused");
  policy.Statement = policy.Statement.filter((statement) => object(statement).Sid !== "AllowRecorderArchiveCloudFront");
  return result;
}
export function retirementStack(stack: ConfiguredStack<unknown, never>) {
  if (stack.stackName !== "archive-cdn") return stack;
  const policy = Provider.effect(BucketPolicy, Effect.gen(function* () {
    const original = yield* Provider.findProvider(BucketPolicy);
    return { ...original, delete: Effect.fn(function* ({ output }: Parameters<typeof original.delete>[0]) {
      const current = yield* readPolicy(output.bucket);
      if (!current) return yield* Effect.die("Artifacts bucket policy missing; retirement refused");
      const before = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.MutableJson))(current.policy);
      const after = removeDownloadGrant(before);
      if (JSON.stringify(before) !== JSON.stringify(after)) yield* s3.putBucketPolicy({ Bucket: output.bucket, Policy: JSON.stringify(after) });
    }) };
  }).pipe(Effect.provide(stack.providers)));
  return Alchemy.Stack(stack.stackName, { state: stack.state, providers: Layer.merge(stack.providers, policy.pipe(Layer.provide(providers))) }, Effect.void);
}
