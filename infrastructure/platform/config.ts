import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import { Endpoint } from "@distilled.cloud/aws/Endpoint";
import { Region } from "@distilled.cloud/aws/Region";
import * as sts from "@distilled.cloud/aws/sts";
import { Stage } from "alchemy/Stage";
import { stageName } from "./stages.ts";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const environmentName = stageName;
export const environment = Effect.map(Stage, Schema.decodeUnknownSync(environmentName));
export const retiredStage = Effect.die("This persistent Nightly stack is retired; use the migration retirement command, never deploy it");

const defaultRegion = "ap-southeast-1";
const awsEnvironmentForRegion = (region: string) => {
  const credentials = Credentials.fromNodeProviderChain().pipe(Layer.orDie);
  // STS must not inherit an endpoint derived from AWSEnvironment while resolving that environment.
  const client = Layer.mergeAll(credentials, Layer.succeed(Region, Effect.succeed(region)), Layer.succeed(Endpoint, Effect.undefined), FetchHttpClient.layer);
  return Layer.effect(
    AWSEnvironment,
    Effect.gen(function* () {
      const resolveCredentials = yield* Credentials.Credentials;
      yield* resolveCredentials.pipe(Effect.catch(() => Effect.die("Missing AWS credentials; set AWS_PROFILE for the protected operator profile or supply the CI/instance role credential chain")));
      return yield* Effect.cached(
        Effect.gen(function* () {
          const identity = yield* sts.getCallerIdentity({}).pipe(Effect.orDie);
          if (!identity.Account) return yield* Effect.die("AWS STS returned no account.");
          return { accountId: identity.Account, region, credentials: resolveCredentials.pipe(Effect.orDie) };
        }).pipe(Effect.provide(client)),
      );
    }),
  ).pipe(Layer.provide(client));
};

export const awsProviders = (region: string) => AWS.providers().pipe(Layer.provide(awsEnvironmentForRegion(region)));
export const providers = awsProviders(defaultRegion);
// The account and region of this run, resolved from the operator credentials.
export const awsEnvironment = awsEnvironmentForRegion(defaultRegion);
export const state = AWS.state({ migrateFrom: false }).pipe(Layer.provide(awsEnvironmentForRegion(defaultRegion)));
