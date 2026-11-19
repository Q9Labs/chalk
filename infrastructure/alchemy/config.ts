import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import { Endpoint } from "@distilled.cloud/aws/Endpoint";
import { Region } from "@distilled.cloud/aws/Region";
import * as sts from "@distilled.cloud/aws/sts";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const environmentName = Schema.Literals(["nightly", "production"]);
export const environment = Effect.map(Stage, Schema.decodeUnknownSync(environmentName));
export const nightly = Effect.gen(function* () {
  const stage = yield* environment;
  if (stage !== "nightly") {
    return yield* Effect.die("This stack only manages Nightly resources; use --stage nightly.");
  }
  return stage;
});

const region = "ap-southeast-1";
const credentials = Credentials.fromNodeProviderChain().pipe(Layer.orDie);
// STS must not inherit an endpoint derived from AWSEnvironment while resolving that environment.
const client = Layer.mergeAll(credentials, Layer.succeed(Region, Effect.succeed(region)), Layer.succeed(Endpoint, Effect.undefined), FetchHttpClient.layer);
const awsEnvironment = Layer.effect(
  AWSEnvironment,
  Effect.gen(function* () {
    const resolveCredentials = yield* Credentials.Credentials;
    return yield* Effect.cached(
      Effect.gen(function* () {
        const identity = yield* sts.getCallerIdentity({}).pipe(Effect.orDie);
        if (!identity.Account) return yield* Effect.die("AWS STS returned no account.");
        return { accountId: identity.Account, region, credentials: resolveCredentials.pipe(Effect.orDie) };
      }).pipe(Effect.provide(client)),
    );
  }),
).pipe(Layer.provide(client));

export const providers = AWS.providers().pipe(Layer.provide(awsEnvironment));
export const state = AWS.state().pipe(Layer.provide(awsEnvironment));
