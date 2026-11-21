import * as AWS from "@alchemy.run/aws";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { canonicalSetJson } from "./aws-bucket-policy.ts";

// KMS returns Condition keys in varying order, and upstream KMS.Key keeps the raw policy text it read
// (alchemy-run/alchemy#3531), so drift reports an unchanged key. Remove this wrapper once that is fixed.
export const keepRecordedPolicy = <Live extends { readonly policy?: string | undefined }>(live: Live | undefined, recorded: string | undefined) =>
  live?.policy !== undefined && recorded !== undefined && live.policy !== recorded && canonicalSetJson(live.policy) === canonicalSetJson(recorded) ? { ...live, policy: recorded } : live;

export const kmsKeyProvider = Provider.effect(
  AWS.KMS.Key,
  Effect.gen(function* () {
    const upstream = yield* Provider.findProvider(AWS.KMS.Key);
    const read: NonNullable<Provider.ProviderService<AWS.KMS.Key>["read"]> = (input) => (upstream.read ? upstream.read(input).pipe(Effect.map((live) => keepRecordedPolicy(live, input.output?.policy))) : Effect.undefined);
    return { ...upstream, read };
  }),
);
