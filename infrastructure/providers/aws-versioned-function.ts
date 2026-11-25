import * as lambda from "@distilled.cloud/aws/lambda";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import { Stage } from "alchemy/Stage";
import { refuse } from "../platform/refusal.ts";
import { parseStage } from "../platform/stages.ts";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

const functionProps = Schema.Struct({
  functionName: Schema.String,
  description: Schema.String,
  role: Schema.String,
  runtime: Schema.Union([Schema.Literal("nodejs22.x"), Schema.Literal("provided.al2023")]),
  handler: Schema.String,
  architectures: Schema.Array(Schema.Literal("arm64")),
  code: Schema.Struct({ bucket: Schema.String, key: Schema.String, version: Schema.String, sha256: Schema.String }),
  timeout: Schema.Number,
  memorySize: Schema.Number,
  reservedConcurrency: Schema.Number,
  ephemeralStorageSize: Schema.Number,
  environment: Schema.Redacted(Schema.Record(Schema.String, Schema.String)),
  tracingMode: Schema.Literal("Active"),
  eventInvokeConfig: Schema.Struct({ maximumEventAge: Schema.Number, maximumRetryAttempts: Schema.Number, onFailure: Schema.String }),
  tags: Schema.Record(Schema.String, Schema.String),
});
export type FunctionProps = typeof functionProps.Type;
interface VersionedFunction extends Resource<
  "Chalk.Lambda.VersionedFunction",
  FunctionProps,
  {
    functionName: string;
    functionArn: string;
    codeSha256: string;
    version: string;
    configuration: Omit<FunctionProps, "code" | "reservedConcurrency" | "eventInvokeConfig"> & Partial<Pick<FunctionProps, "reservedConcurrency" | "eventInvokeConfig">>;
  }
> {}
export const VersionedFunction = Resource<VersionedFunction>("Chalk.Lambda.VersionedFunction");

const required = <T>(value: T | undefined, name: string): T => {
  if (value === undefined) throw new Error(`Lambda did not return ${name}; values are not logged.`);
  return value;
};
// GetFunction omits `Tags` and reports `TagsError` when it cannot read them. That is "unknown", never
// "no tags": ask ListTags, and fail with a typed refusal when that cannot answer either. A typed
// failure keeps the engine's checkpoint; a missing answer read as "foreign" would make it drop the
// checkpoint and leave the function running.
const tagsOf = Effect.fn(function* (current: lambda.GetFunctionResponse) {
  if (current.Tags) return current.Tags;
  const arn = current.Configuration?.FunctionArn;
  const listed =
    arn === undefined
      ? undefined
      : yield* lambda.listTags({ Resource: arn }).pipe(
          Effect.map((result) => result.Tags),
          Effect.catch(() => Effect.undefined),
        );
  return listed ?? (yield* refuse(`The tags of Lambda function ${current.Configuration?.FunctionName ?? "(unnamed)"} cannot be read (GetFunction reported ${current.TagsError?.ErrorCode ?? "no tags"}), so its ownership is unproven; nothing was changed. Retry when tags are readable`));
});
const readFunction = Effect.fn(function* (functionName: string) {
  const current = yield* lambda.getFunction({ FunctionName: functionName }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
  if (!current?.Configuration) return undefined;
  const config = current.Configuration;
  const hasUnsupportedConfiguration = () =>
    [
      config.VpcConfig?.VpcId,
      config.VpcConfig?.SubnetIds?.length,
      config.VpcConfig?.SecurityGroupIds?.length,
      config.Layers?.length,
      config.FileSystemConfigs?.length,
      config.KMSKeyArn,
      config.DeadLetterConfig?.TargetArn,
      config.LoggingConfig?.LogGroup && config.LoggingConfig.LogGroup !== `/aws/lambda/${functionName}`,
      config.LoggingConfig?.LogFormat && config.LoggingConfig.LogFormat !== "Text",
    ].some(Boolean);
  if (hasUnsupportedConfiguration()) {
    return yield* refuse("Dispatcher has an unexpected networking, encryption, layer or logging configuration; refusing to proceed");
  }
  const runOwned = (yield* Stage).startsWith("nightly-");
  const invoke = yield* lambda.getFunctionEventInvokeConfig({ FunctionName: functionName }).pipe(Effect.catchTag("ResourceNotFoundException", (error) => (runOwned ? Effect.undefined : Effect.fail(error))));
  const environment = Object.fromEntries(Object.entries(config.Environment?.Variables ?? {}).map(([key, value]) => [key, typeof value === "string" ? value : Redacted.value(required(value, "environment variable"))]));
  const configuration = Schema.decodeUnknownSync(
    Schema.Struct({ ...functionProps.fields, code: Schema.optionalKey(functionProps.fields.code), reservedConcurrency: Schema.optionalKey(functionProps.fields.reservedConcurrency), eventInvokeConfig: Schema.optionalKey(functionProps.fields.eventInvokeConfig) }),
  )({
    functionName,
    description: config.Description ?? "",
    role: config.Role,
    runtime: config.Runtime,
    handler: config.Handler,
    architectures: config.Architectures,
    timeout: config.Timeout,
    memorySize: config.MemorySize,
    ...(current.Concurrency?.ReservedConcurrentExecutions === undefined ? {} : { reservedConcurrency: current.Concurrency.ReservedConcurrentExecutions }),
    ephemeralStorageSize: config.EphemeralStorage?.Size,
    environment: Redacted.make(environment),
    tracingMode: config.TracingConfig?.Mode,
    ...(invoke ? { eventInvokeConfig: { maximumEventAge: invoke.MaximumEventAgeInSeconds, maximumRetryAttempts: invoke.MaximumRetryAttempts, onFailure: invoke.DestinationConfig?.OnFailure?.Destination } } : {}),
    tags: Object.fromEntries(Object.entries(yield* tagsOf(current)).filter(([key]) => !key.startsWith("alchemy:"))),
  });
  if (!runOwned) Schema.decodeUnknownSync(Schema.Struct({ ...functionProps.fields, code: Schema.optionalKey(functionProps.fields.code) }))(configuration);
  return { functionName, functionArn: required(config.FunctionArn, "function ARN"), codeSha256: required(config.CodeSha256, "code digest"), version: required(config.Version, "version"), configuration };
});

// Ownership is a fact stamped on the function, never inferred from its name. The
// engine persists the resource's instance ID before any cloud call, and creation
// writes that ID as this tag in the same request. The `alchemy:` prefix keeps it out
// of the compared configuration. A function without this run's ID is not ours.
const ownerTagKey = "alchemy:instance";
const isOwnedBy = Effect.fn(function* (functionName: string, instanceId: string) {
  const current = yield* lambda.getFunction({ FunctionName: functionName }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
  return current ? (yield* tagsOf(current))[ownerTagKey] === instanceId : undefined;
});
const readOwned = Effect.fn(function* (functionName: string, instanceId: string) {
  const live = yield* readFunction(functionName);
  if (!live) return undefined;
  // Production's function was created by OpenTofu and seeded; only run-owned stages create one here.
  if (!(yield* Stage).startsWith("nightly-")) return live;
  return (yield* isOwnedBy(functionName, instanceId)) ? live : Unowned(live);
});

class NotSettled extends Data.TaggedError("NotSettled") {}

const settled = Effect.fn(function* (functionName: string) {
  return yield* lambda.getFunctionConfiguration({ FunctionName: functionName }).pipe(
    Effect.flatMap((config) => (config.State === "Active" && config.LastUpdateStatus === "Successful" ? Effect.succeed(config) : Effect.fail(new NotSettled()))),
    Effect.retry({ while: (error) => error._tag === "NotSettled", schedule: Schedule.spaced("2 seconds"), times: 90 }),
  );
});

export function requireRunOwnedFunction(stageName: string, functionName: string) {
  const stage = parseStage(stageName);
  if (stage.kind !== "ephemeral" || functionName !== `chalk-${stage.name}-transcription-dispatcher`) throw new Error("Only a stage-scoped ephemeral dispatcher function may be created or deleted");
}
type Configuration = Pick<FunctionProps, "environment">;
// Lambda returns environment variables in its own order, and deepEqual compares a redacted record in
// key order, so the same variables in another order must not count as a difference.
const environmentByKey = <T extends Configuration>(configuration: T) => ({
  ...configuration,
  environment: Redacted.make(Object.fromEntries(Object.entries(Redacted.value(configuration.environment)).sort(([left], [right]) => left.localeCompare(right)))),
});
const sameConfiguration = (live: Configuration, desired: Configuration) => deepEqual(environmentByKey(live), environmentByKey(desired));

const createRunFunction = Effect.fn(function* (news: FunctionProps, instanceId: string) {
  requireRunOwnedFunction(yield* Stage, news.functionName);
  yield* lambda
    .createFunction({
      FunctionName: news.functionName,
      Description: news.description,
      Role: news.role,
      Runtime: news.runtime,
      Handler: news.handler,
      Architectures: [...news.architectures],
      Code: { S3Bucket: news.code.bucket, S3Key: news.code.key, S3ObjectVersion: news.code.version },
      Publish: false,
      Timeout: news.timeout,
      MemorySize: news.memorySize,
      EphemeralStorage: { Size: news.ephemeralStorageSize },
      Environment: { Variables: Redacted.value(news.environment) },
      TracingConfig: { Mode: news.tracingMode },
      Tags: { ...news.tags, [ownerTagKey]: instanceId },
    })
    .pipe(Effect.retry({ while: (error) => error._tag === "ExecutionRoleNotAssumable" || (error._tag === "InvalidParameterValueException" && /role.*assum/i.test(error.message)), schedule: Schedule.spaced("2 seconds"), times: 30 }));
  yield* lambda.getFunctionConfiguration({ FunctionName: news.functionName }).pipe(
    Effect.flatMap((config) => (config.State === "Active" ? Effect.succeed(config) : Effect.fail(new NotSettled()))),
    Effect.retry({ while: (error) => error._tag === "NotSettled", schedule: Schedule.spaced("2 seconds"), times: 90 }),
  );
  yield* lambda.putFunctionConcurrency({ FunctionName: news.functionName, ReservedConcurrentExecutions: news.reservedConcurrency });
  yield* lambda.putFunctionEventInvokeConfig({ FunctionName: news.functionName, MaximumEventAgeInSeconds: news.eventInvokeConfig.maximumEventAge, MaximumRetryAttempts: news.eventInvokeConfig.maximumRetryAttempts, DestinationConfig: { OnFailure: { Destination: news.eventInvokeConfig.onFailure } } });
  const result = yield* readFunction(news.functionName);
  const { code, ...configuration } = news;
  if (!result || result.codeSha256 !== code.sha256 || !sameConfiguration(result.configuration, configuration)) return yield* refuse("Ephemeral dispatcher exact ZIP/configuration readback failed; no values logged");
  return result;
});

// Cloud Control can select S3 ZIPs, but its generic provider patches the write-only
// Code on *every* reconcile. It cannot read back CodeSha256. Use Lambda's revision
// preconditions and verify the exact ZIP digest without rebuilding or publishing.
export const functionProvider = Provider.succeed(VersionedFunction, {
  stables: ["functionName", "functionArn"],
  read: ({ olds, output, instanceId }) => (output ? readOwned(output.functionName, instanceId) : isResolved(olds) && olds ? readOwned(olds.functionName, instanceId) : Effect.undefined),
  diff: Effect.fn(function* ({ olds, news }) {
    if (isResolved(news) && olds.functionName !== news.functionName) return { action: "replace" };
  }),
  reconcile: Effect.fn(function* ({ news, olds, instanceId }) {
    if (!olds) return yield* createRunFunction(news, instanceId);
    const before = yield* settled(news.functionName);
    const live = yield* readFunction(news.functionName);
    if (!live) return yield* refuse("Dispatcher function is missing; this migration never creates it.");
    const { code, ...configuration } = news;
    // Select the immutable object even when it contains identical bytes under a
    // new release key. Never rebuild, publish a version, or change architecture.
    const codeChanged = () => !deepEqual(olds?.code, code) || before.CodeSha256 !== code.sha256;
    if (codeChanged()) {
      yield* lambda.updateFunctionCode({ FunctionName: news.functionName, S3Bucket: code.bucket, S3Key: code.key, S3ObjectVersion: code.version, RevisionId: before.RevisionId, Publish: false });
      yield* settled(news.functionName);
    }
    if (!sameConfiguration(live.configuration, configuration)) {
      const current = yield* settled(news.functionName);
      yield* lambda.updateFunctionConfiguration({
        FunctionName: news.functionName,
        RevisionId: current.RevisionId,
        Description: news.description,
        Role: news.role,
        Runtime: news.runtime,
        Handler: news.handler,
        Timeout: news.timeout,
        MemorySize: news.memorySize,
        EphemeralStorage: { Size: news.ephemeralStorageSize },
        Environment: { Variables: Redacted.value(news.environment) },
        TracingConfig: { Mode: news.tracingMode },
      });
      yield* settled(news.functionName);
      if (live.configuration.reservedConcurrency !== news.reservedConcurrency) yield* lambda.putFunctionConcurrency({ FunctionName: news.functionName, ReservedConcurrentExecutions: news.reservedConcurrency });
      if (!deepEqual(live.configuration.eventInvokeConfig, news.eventInvokeConfig))
        yield* lambda.putFunctionEventInvokeConfig({
          FunctionName: news.functionName,
          MaximumEventAgeInSeconds: news.eventInvokeConfig.maximumEventAge,
          MaximumRetryAttempts: news.eventInvokeConfig.maximumRetryAttempts,
          DestinationConfig: { OnFailure: { Destination: news.eventInvokeConfig.onFailure } },
        });
      const removed = Object.keys(live.configuration.tags).filter((key) => !(key in news.tags));
      if (removed.length) yield* lambda.untagResource({ Resource: live.functionArn, TagKeys: removed });
      yield* lambda.tagResource({ Resource: live.functionArn, Tags: news.tags });
    }
    const result = yield* readFunction(news.functionName);
    if (!result || result.codeSha256 !== code.sha256 || !sameConfiguration(result.configuration, configuration)) return yield* refuse("Dispatcher exact ZIP/configuration readback failed; no values logged.");
    return result;
  }),
  delete: Effect.fn(function* ({ output, instanceId }) {
    requireRunOwnedFunction(yield* Stage, output.functionName);
    const owned = yield* isOwnedBy(output.functionName, instanceId);
    if (owned === undefined) return;
    if (!owned) return yield* refuse("Refusing to delete a Lambda function that this run did not create; its ownership tag is missing or belongs to another run");
    yield* lambda.deleteFunction({ FunctionName: output.functionName }).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
  }),
});
