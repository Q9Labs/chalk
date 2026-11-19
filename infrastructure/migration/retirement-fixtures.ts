import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { inMemoryState } from "alchemy/State";
import type { CreatedResourceState, ResourceState } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { retire, settle, type RetireMode } from "./retirement-transition.ts";

// Shared fake cloud and legacy dispatcher records for the retirement tests.
export const stackName = "transcription-dispatcher";
export const fn = "chalk-nightly-transcription-dispatcher";
export const account = "000000000000";
export const region = "ap-southeast-1";
const arn = `arn:aws:lambda:${region}:${account}:function:${fn}`;
export const queueAttr = (name: string) => ({ queueName: name, queueUrl: `https://sqs.${region}.amazonaws.com/${account}/${name}`, queueArn: `arn:aws:sqs:${region}:${account}:${name}` });
// The run-time account and region the legacy identities are checked against.
const awsEnvironment = Layer.succeed(AWSEnvironment, Effect.succeed({ accountId: account, region, credentials: Effect.succeed({ accessKeyId: Redacted.make("test"), secretAccessKey: Redacted.make("test"), sessionToken: undefined, region }) }));
export const tags = { chalk_environment: "nightly", chalk_component: "transcription-dispatcher" };
type Rows = Record<string, ResourceState>;

export const created = (logicalId: string, resourceType: string, props: Record<string, unknown>, attr: Record<string, unknown>): CreatedResourceState => ({
  status: "created",
  resourceType,
  logicalId,
  fqn: logicalId,
  namespace: undefined,
  instanceId: logicalId,
  providerVersion: 0,
  props,
  attr,
  bindings: [],
  downstream: [],
  removalPolicy: "retain",
});
// The 14 records the Nightly seed left, each retained, with the physical names of the saved stage.
export const seeded = (): CreatedResourceState[] => [
  created("ExecutionRole", "AWS.IAM.Role", { tags }, { roleName: `${fn}-execution` }),
  created("SchedulerRole", "AWS.IAM.Role", {}, { roleName: `${fn}-scheduler` }),
  created("AsyncFailure", "AWS.SQS.Queue", { tags }, queueAttr(`${fn}-async-failure`)),
  created("SchedulerDlq", "AWS.SQS.Queue", { tags }, queueAttr(`${fn}-scheduler-dlq`)),
  created("Logs", "AWS.Logs.LogGroup", { tags }, { logGroupName: `/aws/lambda/${fn}` }),
  created("Function", "Chalk.Lambda.VersionedFunction", { tags }, { functionName: fn }),
  created("Reconcile", "AWS.Scheduler.Schedule", {}, { scheduleName: "chalk-nightly-transcription-reconcile", groupName: "chalk-nightly" }),
  created("SchedulerPermission", "AWS.Lambda.Permission", {}, { statementId: "AllowEventBridgeSchedulerWake", functionName: arn }),
  created("ControlApiPermission", "AWS.Lambda.Permission", {}, { statementId: "AllowControlApiWake", functionName: arn }),
  ...["Errors:errors", "Throttles:throttles", "AsyncEventsDropped:async-events-dropped", "AsyncFailureDepth:async-failure-depth", "SchedulerTargetErrors:scheduler-target-errors"].map((pair) => {
    const [id = "", suffix = ""] = pair.split(":");
    return created(id, "AWS.CloudWatch.Alarm", {}, { alarmName: `${fn}-${suffix}` });
  }),
];
const rowsOf = (list: readonly ResourceState[]): Rows => Object.fromEntries(list.map((row) => [row.fqn, row]));

interface LiveAttr {
  readonly marker: string;
  readonly state?: string;
  readonly scheduleName?: string;
  readonly groupName?: string;
}
interface Fake extends Resource<string, { readonly marker?: string }, LiveAttr> {}
// The cloud boundary: one counting provider per legacy resource type. The planner, the state store,
// cleanup and the transition are the real code.
function fakeCloud(types: readonly string[]) {
  const deleted: string[] = [];
  const failOnce = new Set<string>();
  const missing = new Set<string>();
  const live = new Map<string, LiveAttr>();
  const providers = types.map((type) =>
    Provider.succeed(Resource<Fake>(type), {
      read: ({ fqn }) => Effect.succeed(missing.has(fqn) ? undefined : (live.get(fqn) ?? { marker: fqn })),
      reconcile: () => Effect.die("retirement never reconciles"),
      delete: ({ instanceId }) =>
        Effect.suspend(() => {
          if (failOnce.delete(instanceId)) return Effect.die(`injected crash deleting ${instanceId}`);
          deleted.push(instanceId);
          return Effect.void;
        }),
    }),
  );
  return { layer: providers.reduce((all, one) => Layer.merge(all, one), Layer.empty), deleted, failOnce, missing, live };
}
export const inventorySize = seeded().length;
const legacyTypes = [...new Set(seeded().map((row) => row.resourceType)), "AWS.S3.Bucket", "AWS.KMS.Key"];

export function setup(rows: readonly ResourceState[]) {
  const state: Record<string, Record<string, Rows>> = { [stackName]: { nightly: rowsOf(rows) } };
  const cloud = fakeCloud(legacyTypes);
  const stack = Alchemy.Stack(stackName, { providers: cloud.layer, state: inMemoryState(state, { [stackName]: { nightly: { saved: true } } }) }, Effect.void);
  const run = (mode: RetireMode) => Effect.runPromiseExit(retire(stack, mode).pipe(Effect.provide(Alchemist.layer()), Effect.provide(awsEnvironment)));
  const settleRun = () => Effect.runPromiseExit(settle(stack).pipe(Effect.provide(Alchemist.layer()), Effect.provide(awsEnvironment)));
  const remaining = () => Object.values(state[stackName]?.nightly ?? {});
  return { state, cloud, stack, run, settleRun, remaining };
}
export const failureText = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
export const snapshot = (rows: readonly ResourceState[]) => JSON.stringify(rows);
export const withAttr = (rows: CreatedResourceState[], logicalId: string, attr: Record<string, unknown>): ResourceState[] => rows.map((row) => (row.logicalId === logicalId ? { ...row, attr: { ...row.attr, ...attr } } : row));
export const survivors = (...ids: string[]) => seeded().filter((row) => ids.includes(row.logicalId));
export const interrupted = (rows: CreatedResourceState[]): ResourceState[] =>
  rows.map((row) =>
    row.logicalId === "Reconcile"
      ? {
          status: "updating",
          resourceType: row.resourceType,
          logicalId: row.logicalId,
          fqn: row.fqn,
          namespace: undefined,
          instanceId: row.instanceId,
          providerVersion: 0,
          props: { state: "ENABLED" },
          old: { props: row.props, attr: row.attr, bindings: [], removalPolicy: "retain" },
          bindings: [],
          downstream: [],
          removalPolicy: "retain",
        }
      : row,
  );

// A target other than the dispatcher has an empty expected inventory, so any record it holds is refused
// and nothing is destroyed; an empty stage has nothing to refuse.
export const controlEndpoint = (rows: readonly ResourceState[]) => {
  const cloud = fakeCloud(["AWS.CloudFront.Distribution"]);
  const state: Record<string, Record<string, Rows>> = { "recording-control-address": { nightly: rowsOf(rows) } };
  const stack = Alchemy.Stack("recording-control-address", { providers: cloud.layer, state: inMemoryState(state) }, Effect.void);
  const run = (mode: RetireMode) => Effect.runPromiseExit(retire(stack, mode).pipe(Effect.provide(Alchemist.layer()), Effect.provide(awsEnvironment)));
  return { cloud, run, state };
};
