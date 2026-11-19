import * as s3 from "@distilled.cloud/aws/s3";
import * as Provider from "alchemy/Provider";
import { isResolved } from "alchemy/Diff";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// Canonicalize only at the AWS JSON boundary; policy text order has no IAM meaning.
const sortJson = (value: Schema.Json, unorderedArrays = false): Schema.Json => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = value.map((item) => sortJson(item, unorderedArrays));
    return unorderedArrays ? items.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))) : items;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child, unorderedArrays)]),
  );
};
export const canonicalPolicy = (policy: string): string => JSON.stringify(sortJson(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(policy)));

// IAM action/context lists and firewall/CORS/lifecycle lists are unordered.
export const canonicalSetJson = (value: object | string): string => JSON.stringify(sortJson(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Json))(typeof value === "string" ? value : JSON.stringify(value)), true));

export interface BucketPolicy extends Resource<"Chalk.S3.BucketPolicy", { bucket: string; policy: string }, { bucket: string; policy: string }> {}
export const BucketPolicy = Resource<BucketPolicy>("Chalk.S3.BucketPolicy");

export const readPolicy = Effect.fn(function* (bucket: string) {
  const current = yield* s3.getBucketPolicy({ Bucket: bucket }).pipe(Effect.catchTag("NoSuchBucketPolicy", () => Effect.undefined));
  return current?.Policy ? { bucket, policy: canonicalPolicy(current.Policy) } : undefined;
});

export const bucketPolicyProvider = Provider.succeed(BucketPolicy, {
  stables: ["bucket"],
  list: () => Effect.succeed([]),
  read: ({ olds, output }) => readPolicy(output?.bucket ?? olds.bucket),
  diff: Effect.fn(function* ({ olds, news }) {
    if (isResolved(news) && olds.bucket !== news.bucket) return { action: "replace" };
  }),
  reconcile: Effect.fn(function* ({ news }) {
    const policy = canonicalPolicy(news.policy);
    const current = yield* readPolicy(news.bucket);
    if (current?.policy !== policy) yield* s3.putBucketPolicy({ Bucket: news.bucket, Policy: policy });
    return { bucket: news.bucket, policy };
  }),
  delete: ({ output }) => s3.deleteBucketPolicy({ Bucket: output.bucket }).pipe(Effect.catchTag("NoSuchBucket", () => Effect.void)),
});
