import * as AWS from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Alchemy from "alchemy";
import { State } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { readFile } from "node:fs/promises";
import { environment, providers, state } from "../platform/config.ts";
import { alarmProvider } from "../providers/aws-dispatcher-alarm.ts";
import { VersionedFunction, functionProvider } from "../providers/aws-versioned-function.ts";
import { parseInputs, requireInput } from "./config.ts";
import { resourceProps } from "./resources.ts";

export const stackName = "transcription-dispatcher";
export const dispatcherProviders = Layer.mergeAll(providers, functionProvider.pipe(Layer.provide(providers)), alarmProvider);
export const storedInputs = (value: unknown) => {
  const output = Schema.decodeUnknownSync(Schema.Struct({ dispatcher_inputs: Schema.Redacted(Schema.Unknown) }))(value);
  return parseInputs(Redacted.value(output.dispatcher_inputs));
};
export default Alchemy.Stack(
  stackName,
  { providers: dispatcherProviders, state },
  Effect.gen(function* () {
    const stage = yield* environment;
    const service = Option.getOrThrow(yield* Effect.serviceOption(State));
    const store = yield* service;
    const previous = yield* store.getOutput({ stack: stackName, stage });
    requireInput(previous !== undefined, "Dispatcher has no Alchemy state; run the explicit seed command before releases");
    const file = process.env.CHALK_DISPATCHER_INPUTS;
    const input = file ? parseInputs(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(yield* Effect.tryPromise(() => readFile(file, "utf8")))) : storedInputs(previous);
    requireInput(input.environment_name === stage, "Dispatcher input environment does not match stage");
    const aws = yield* AWSEnvironment.current;
    const props = resourceProps(input, aws.accountId, aws.region);
    yield* AWS.Logs.LogGroup("Logs", props.log);
    const failure = yield* AWS.SQS.Queue("AsyncFailure", props.asyncFailure);
    const dlq = yield* AWS.SQS.Queue("SchedulerDlq", props.schedulerDlq);
    const execution = yield* AWS.IAM.Role("ExecutionRole", props.executionRole);
    const fn = yield* VersionedFunction("Function", { ...props.fn, role: execution.roleArn, eventInvokeConfig: { ...props.fn.eventInvokeConfig, onFailure: failure.queueArn } });
    const scheduler = yield* AWS.IAM.Role("SchedulerRole", props.schedulerRole);
    const schedule = yield* AWS.Scheduler.Schedule("Reconcile", { ...props.schedule, target: { ...props.schedule.target, Arn: fn.functionArn, RoleArn: scheduler.roleArn, DeadLetterConfig: { Arn: dlq.queueArn } } });
    yield* AWS.Lambda.Permission("SchedulerPermission", { ...props.schedulerPermission, functionName: fn.functionName, sourceArn: schedule.scheduleArn });
    if (props.controlPermission) yield* AWS.Lambda.Permission("ControlApiPermission", { ...props.controlPermission, functionName: fn.functionName });
    for (const [name, alarm] of Object.entries(props.alarms)) yield* AWS.CloudWatch.Alarm(name, alarm);
    return props.outputs;
  }).pipe(Effect.orDie),
);
