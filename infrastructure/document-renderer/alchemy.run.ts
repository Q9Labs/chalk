import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Alchemy from "alchemy";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import { environment, providers, state } from "../platform/config.ts";
import { alarmProvider } from "../providers/aws-dispatcher-alarm.ts";
import { logGroupProvider } from "../providers/aws-run-owned.ts";
import { VersionedFunction, functionProvider } from "../providers/aws-versioned-function.ts";
import { parseInputs, requireInput } from "./config.ts";
import { resourceProps } from "./resources.ts";

export const stackName = "document-renderer";
import * as Layer from "effect/Layer";
export const rendererProviders = Layer.mergeAll(providers, functionProvider.pipe(Layer.provide(providers)), alarmProvider, logGroupProvider(providers));
const storedInputs = (value: unknown) => {
  const output = Schema.decodeUnknownSync(Schema.Struct({ renderer_inputs: Schema.Redacted(Schema.Unknown) }))(value);
  return parseInputs(Redacted.value(output.renderer_inputs));
};
export default Alchemy.Stack(
  stackName,
  { providers: rendererProviders, state },
  Effect.gen(function* () {
    const stage = yield* environment;
    const service = Option.getOrThrow(yield* Effect.serviceOption(State));
    const store = yield* service;
    const previous = yield* store.getOutput({ stack: stackName, stage });
    const file = process.env.CHALK_INFRA_INPUTS;
    requireInput(previous !== undefined || file !== undefined, "A renderer deploy requires CHALK_INFRA_INPUTS unless state already exists");
    const input = file ? parseInputs(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(yield* Effect.tryPromise(() => readFile(file, "utf8")))) : storedInputs(previous);
    requireInput(input.environment_name === stage, "Renderer input environment does not match stage");
    const aws = yield* AWSEnvironment.current;
    const props = resourceProps(input, aws.accountId, aws.region);
    const logGroup = yield* AWS.Logs.LogGroup("Logs", props.log);
    yield* AWS.Logs.MetricFilter("FailureLogMetric", { ...props.failureLogMetric, logGroupName: logGroup.logGroupName });
    const execution = yield* AWS.IAM.Role("ExecutionRole", props.executionRole);
    const fn = yield* VersionedFunction("Function", { ...props.fn, role: execution.roleArn });
    if (props.controlPermission) yield* AWS.Lambda.Permission("ControlApiPermission", { ...props.controlPermission, functionName: fn.functionName });
    for (const [name, alarm] of Object.entries(props.alarms)) yield* AWS.CloudWatch.Alarm(name, alarm);
    return props.outputs;
  }).pipe(Effect.orDie),
);
