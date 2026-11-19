import * as lambda from "@distilled.cloud/aws/lambda";
import { deepEqual, isResolved } from "alchemy/Diff";
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
  runtime: Schema.Literal("nodejs22.x"),
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
    configuration: Omit<FunctionProps, "code">;
  }
> {}
export const VersionedFunction = Resource<VersionedFunction>("Chalk.Lambda.VersionedFunction");

const required = <T>(value: T | undefined, name: string): T => {
  if (value === undefined) throw new Error(`Lambda did not return ${name}; values are not logged.`);
  return value;
};
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
    return yield* Effect.die("Dispatcher has an unexpected networking, encryption, layer or logging configuration; refusing to proceed");
  }
  const invoke = yield* lambda.getFunctionEventInvokeConfig({ FunctionName: functionName });
  const environment = Object.fromEntries(Object.entries(config.Environment?.Variables ?? {}).map(([key, value]) => [key, typeof value === "string" ? value : Redacted.value(required(value, "environment variable"))]));
  const configuration = Schema.decodeUnknownSync(Schema.Struct({ ...functionProps.fields, code: Schema.optionalKey(functionProps.fields.code) }))({
    functionName,
    description: config.Description ?? "",
    role: config.Role,
    runtime: config.Runtime,
    handler: config.Handler,
    architectures: config.Architectures,
    timeout: config.Timeout,
    memorySize: config.MemorySize,
    reservedConcurrency: current.Concurrency?.ReservedConcurrentExecutions,
    ephemeralStorageSize: config.EphemeralStorage?.Size,
    environment: Redacted.make(environment),
    tracingMode: config.TracingConfig?.Mode,
    eventInvokeConfig: { maximumEventAge: invoke.MaximumEventAgeInSeconds, maximumRetryAttempts: invoke.MaximumRetryAttempts, onFailure: invoke.DestinationConfig?.OnFailure?.Destination },
    tags: Object.fromEntries(Object.entries(current.Tags ?? {}).filter(([key]) => !key.startsWith("alchemy:"))),
  });
  return { functionName, functionArn: required(config.FunctionArn, "function ARN"), codeSha256: required(config.CodeSha256, "code digest"), version: required(config.Version, "version"), configuration };
});

class NotSettled extends Data.TaggedError("NotSettled") {}

const settled = Effect.fn(function* (functionName: string) {
  return yield* lambda.getFunctionConfiguration({ FunctionName: functionName }).pipe(
    Effect.flatMap((config) => (config.State === "Active" && config.LastUpdateStatus === "Successful" ? Effect.succeed(config) : Effect.fail(new NotSettled()))),
    Effect.retry({ while: (error) => error._tag === "NotSettled", schedule: Schedule.spaced("2 seconds"), times: 90 }),
  );
});

// Cloud Control can select S3 ZIPs, but its generic provider patches the write-only
// Code on *every* reconcile. It cannot read back CodeSha256. Use Lambda's revision
// preconditions and verify the exact ZIP digest without rebuilding or publishing.
export const functionProvider = Provider.succeed(VersionedFunction, {
  stables: ["functionName", "functionArn"],
  read: ({ olds, output }) => (output ? readFunction(output.functionName) : isResolved(olds) && olds ? readFunction(olds.functionName) : Effect.undefined),
  diff: Effect.fn(function* ({ olds, news }) {
    if (isResolved(news) && olds.functionName !== news.functionName) return { action: "replace" };
  }),
  reconcile: Effect.fn(function* ({ news, olds }) {
    const before = yield* settled(news.functionName);
    const live = yield* readFunction(news.functionName);
    if (!live) return yield* Effect.die("Dispatcher function is missing; this migration never creates it.");
    const { code, ...configuration } = news;
    // Select the immutable object even when it contains identical bytes under a
    // new release key. Never rebuild, publish a version, or change architecture.
    const codeChanged = () => !deepEqual(olds?.code, code) || before.CodeSha256 !== code.sha256;
    if (codeChanged()) {
      yield* lambda.updateFunctionCode({ FunctionName: news.functionName, S3Bucket: code.bucket, S3Key: code.key, S3ObjectVersion: code.version, RevisionId: before.RevisionId, Publish: false });
      yield* settled(news.functionName);
    }
    if (!deepEqual(live.configuration, configuration)) {
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
    if (!result || result.codeSha256 !== code.sha256 || !deepEqual(result.configuration, configuration)) return yield* Effect.die("Dispatcher exact ZIP/configuration readback failed; no values logged.");
    return result;
  }),
  delete: () => Effect.die("Dispatcher deletion is forbidden; use the documented state-only rollback."),
});
