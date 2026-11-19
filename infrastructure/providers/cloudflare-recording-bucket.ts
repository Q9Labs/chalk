import * as Cloudflare from "@alchemy.run/cloudflare";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";

interface RecordingBucket extends Resource<"Chalk.R2.RecordingBucket", Cloudflare.R2.BucketProps, Cloudflare.R2.Bucket["Attributes"]> {}
export const RecordingBucket = Resource<RecordingBucket>("Chalk.R2.RecordingBucket");

// Upstream Bucket.read copies CORS/lifecycle from old attributes instead of
// reading those endpoints. Hydrate through lookup so drift really checks them.
export const recordingBucketProvider = Provider.effect(
  RecordingBucket,
  Effect.gen(function* () {
    const upstream = yield* Provider.findProvider(Cloudflare.R2.Bucket);
    return {
      stables: upstream.stables ?? [],
      list: upstream.list,
      read: Effect.fn(function* ({ olds, output }: Parameters<NonNullable<Provider.ProviderService<RecordingBucket>["read"]>>[0]) {
        const name = output?.bucketName ?? olds.name;
        if (!name || !upstream.lookup) return yield* Effect.die("Recording buckets need an explicit physical name and provider lookup.");
        const attr = yield* upstream.lookup({ name, jurisdiction: output?.jurisdiction ?? olds.jurisdiction ?? "default" });
        return attr && !output ? Unowned(attr) : attr;
      }),
      diff: (input: Parameters<NonNullable<Provider.ProviderService<RecordingBucket>["diff"]>>[0]) => (upstream.diff ? upstream.diff(input) : Effect.void),
      reconcile: upstream.reconcile,
      delete: upstream.delete,
    };
  }),
);
