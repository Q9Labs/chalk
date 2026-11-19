import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import * as Alchemist from "alchemy/Alchemist";
import { stripUnowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { isResourceState, State, type StateService } from "alchemy/State";
import type { Attr, CreatedResourceState, Props, ResourceState } from "alchemy/State";
import type { ConfiguredStack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { refuse } from "../platform/refusal.ts";
import { clearStage } from "../releases/cleanup.ts";

// The seeded legacy Nightly dispatcher records all carry removalPolicy "retain", which the planner
// turns into `orphaned` nodes that cleanup refuses. This module is the one explicit transition that
// makes exactly the expected legacy inventory destroyable. Each step validates every record first,
// writes one record at a time, and is a pure function of the records, so a retry after a crash at
// any point ends in the same state. Every step plans first, so it holds the stack/stage lease; the
// lease is bound to the step's scope, so the release step and the destroy step are separate scopes
// and the destroy step validates the inventory again.
const legacyStage = "nightly";
const dispatcher = "transcription-dispatcher";
const legacyFunction = "chalk-nightly-transcription-dispatcher";
const legacyScheduleGroup = "chalk-nightly";
const legacySchedule = "chalk-nightly-transcription-reconcile";

interface Environment {
  readonly accountId: string;
  readonly region: string;
}
// What one expected record must hold. Each attribute is a selector a provider's delete or lookup uses
// (or an identity derived from one). Its recorded value must be exactly one of the listed strings, so
// no record can steer a delete at another resource. The names are the seeded legacy Nightly names;
// account and region come from the run-time identity, never from the repository.
interface Entry {
  readonly type: string;
  readonly identity: Readonly<Record<string, readonly string[]>>;
  readonly tagged: boolean;
}
const role = (suffix: string, tagged: boolean): Entry => ({ type: "AWS.IAM.Role", identity: { roleName: [`${legacyFunction}-${suffix}`] }, tagged });
const queue = ({ accountId, region }: Environment, suffix: string): Entry => {
  const name = `${legacyFunction}-${suffix}`;
  return { type: "AWS.SQS.Queue", tagged: true, identity: { queueName: [name], queueUrl: [`https://sqs.${region}.amazonaws.com/${accountId}/${name}`], queueArn: [`arn:aws:sqs:${region}:${accountId}:${name}`] } };
};
// The permission names its function by name or by ARN; the delete passes either to Lambda.
const permission = ({ accountId, region }: Environment, statementId: string): Entry => ({
  type: "AWS.Lambda.Permission",
  tagged: false,
  identity: { statementId: [statementId], functionName: [legacyFunction, `arn:aws:lambda:${region}:${accountId}:function:${legacyFunction}`] },
});
const alarm = (suffix: string): Entry => ({ type: "AWS.CloudWatch.Alarm", identity: { alarmName: [`${legacyFunction}-${suffix}`] }, tagged: false });
// The legacy naming contract: the types and logical IDs of transcription-dispatcher/policy.ts and the
// names of transcription-dispatcher/resources.ts as they were seeded for Nightly. Only this stack has an
// inventory; every other retirement target expects no record at all.
const inventoryOf = (stackName: string, environment: Environment): Readonly<Record<string, Entry>> =>
  stackName !== dispatcher
    ? {}
    : {
        ExecutionRole: role("execution", true),
        SchedulerRole: role("scheduler", false),
        AsyncFailure: queue(environment, "async-failure"),
        SchedulerDlq: queue(environment, "scheduler-dlq"),
        Logs: { type: "AWS.Logs.LogGroup", identity: { logGroupName: [`/aws/lambda/${legacyFunction}`] }, tagged: true },
        Function: { type: "Chalk.Lambda.VersionedFunction", identity: { functionName: [legacyFunction] }, tagged: true },
        Reconcile: { type: "AWS.Scheduler.Schedule", identity: { scheduleName: [legacySchedule], groupName: [legacyScheduleGroup] }, tagged: false },
        SchedulerPermission: permission(environment, "AllowEventBridgeSchedulerWake"),
        ControlApiPermission: permission(environment, "AllowControlApiWake"),
        Errors: alarm("errors"),
        Throttles: alarm("throttles"),
        AsyncEventsDropped: alarm("async-events-dropped"),
        AsyncFailureDepth: alarm("async-failure-depth"),
        SchedulerTargetErrors: alarm("scheduler-target-errors"),
      };

const taggedNightly = Schema.is(Schema.Struct({ tags: Schema.Struct({ chalk_environment: Schema.Literal("nightly") }) }));

// What the last successful apply left, used to identify the physical resource. A record mid-update
// still names it under `old`. A record mid-delete keeps its attributes but no props: it is only
// acceptable once this transition released it, which validate checks.
type Applied = { readonly props: Props | undefined; readonly attr: Attr };
const lastApplied = (row: ResourceState): Applied | undefined => {
  switch (row.status) {
    case "created":
    case "updated":
      return { props: row.props, attr: row.attr };
    case "updating":
      return { props: row.old.props, attr: row.old.attr };
    case "deleting":
      return row.attr ? { props: undefined, attr: row.attr } : undefined;
    default:
      return undefined;
  }
};
const resumable = (row: ResourceState) => row.status === "deleting" && row.removalPolicy === "destroy";
// `created` and `updated` are both finished states of a successful apply; every other status is in flight.
const isStable = (row: ResourceState) => row.status === "created" || row.status === "updated";

const readRows = Effect.fn(function* (store: StateService, stackName: string) {
  const identity = { stack: stackName, stage: legacyStage };
  const rows: ResourceState[] = [];
  for (const fqn of yield* store.list(identity)) {
    const row = yield* store.get({ ...identity, fqn });
    if (!isResourceState(row)) return yield* refuse(`Record ${fqn} is not a resource; retirement refused`);
    rows.push(row);
  }
  return rows;
});

// Every record must be exactly one expected legacy resource, checked on its own against its fixed
// identity, so a retry that finds only some records left validates the same way. A bucket, a KMS key,
// a retained shared resource or a record from another environment is refused: retirement deletes only
// what the Nightly dispatcher stack itself created.
const identify = Effect.fn(function* (row: ResourceState, inventory: Readonly<Record<string, Entry>>) {
  const expected = row.fqn === row.logicalId ? Object.entries(inventory).find(([id]) => id === row.logicalId)?.[1] : undefined;
  if (!expected) return yield* refuse(`Unexpected record ${row.fqn} (${row.resourceType}); only the legacy Nightly dispatcher inventory may be retired`);
  if (row.resourceType !== expected.type) return yield* refuse(`Record ${row.fqn} is ${row.resourceType}, not the expected ${expected.type}; retirement refused`);
  if (row.removalPolicy !== undefined && row.removalPolicy !== "retain" && row.removalPolicy !== "destroy") return yield* refuse(`Record ${row.fqn} has removal policy ${row.removalPolicy}; retirement refused`);
  const applied = lastApplied(row);
  if (!applied) return yield* refuse(`Record ${row.fqn} is ${row.status}; retirement cannot reason about it. Inspect the live resource by hand`);
  if (row.status === "deleting" && !resumable(row)) return yield* refuse(`Record ${row.fqn} is deleting without having been released by this retirement; inspect the live resource by hand`);
  if (expected.tagged && row.status !== "deleting" && !taggedNightly(applied.props)) return yield* refuse(`Record ${row.fqn} does not carry the saved Nightly environment tag; retirement refused`);
  return { expected, applied };
});

const validate = Effect.fn(function* (rows: readonly ResourceState[], inventory: Readonly<Record<string, Entry>>) {
  for (const row of rows) {
    const { expected, applied } = yield* identify(row, inventory);
    for (const [key, allowed] of Object.entries(expected.identity)) {
      const recorded = Object.entries(applied.attr).find(([name]) => name === key)?.[1];
      if (typeof recorded !== "string") return yield* refuse(`Record ${row.fqn} has no ${key}; retirement refused`);
      if (!allowed.includes(recorded)) return yield* refuse(`Record ${row.fqn} has an unexpected ${key}, outside the legacy Nightly naming; retirement refused`);
    }
  }
});

// Only a record the last apply finished is safe to act on. The message says how to recover.
const requireStable = Effect.fn(function* (rows: readonly ResourceState[]) {
  const unstable = rows.filter((row) => !isStable(row) && !resumable(row));
  if (unstable.length)
    return yield* refuse(`Records ${unstable.map((row) => `${row.fqn} (${row.status})`).join(", ")} are not stable. Run \`pnpm infra retire transcription-dispatcher --settle\`: it re-reads each live resource and marks an interrupted update created, deleting nothing. Then preview again`);
});

// Make exactly the validated records destroyable, one record at a time.
const releaseLegacyDispatcher = Effect.fn(function* (store: StateService, inventory: Readonly<Record<string, Entry>>) {
  const rows = yield* readRows(store, dispatcher);
  yield* validate(rows, inventory);
  yield* requireStable(rows);
  for (const row of rows) {
    if (row.removalPolicy === "destroy") continue;
    yield* store.set({ stack: dispatcher, stage: legacyStage, fqn: row.fqn, value: { ...row, removalPolicy: "destroy" } });
  }
});

// Recovery for records a failed apply left updating: confirm the physical resource exists, then record
// what is live as the created state. Deletes nothing; a resource that is gone is refused.
const settleLegacyDispatcher = Effect.fn(function* (store: StateService, inventory: Readonly<Record<string, Entry>>) {
  const rows = yield* readRows(store, dispatcher);
  yield* validate(rows, inventory);
  const settledIds: string[] = [];
  for (const row of rows) {
    if (isStable(row) || resumable(row)) continue;
    const applied = lastApplied(row);
    if (!applied?.props || row.status !== "updating") return yield* refuse(`Record ${row.fqn} is ${row.status}; only an interrupted update can be settled. Inspect the live resource by hand`);
    const provider = yield* Provider.findProviderByType(row.resourceType);
    if (!provider.read) return yield* refuse(`No read method for ${row.resourceType}`);
    const live = yield* provider.read({ id: row.logicalId, fqn: row.fqn, instanceId: row.instanceId, olds: applied.props, output: applied.attr });
    if (!live) return yield* refuse(`Live ${row.fqn} was not found; settling would invent a record. Inspect it by hand`);
    const settled: CreatedResourceState = {
      status: "created",
      resourceType: row.resourceType,
      logicalId: row.logicalId,
      fqn: row.fqn,
      namespace: row.namespace,
      instanceId: row.instanceId,
      providerVersion: row.providerVersion,
      props: applied.props,
      attr: { ...stripUnowned(live) },
      bindings: row.bindings,
      downstream: row.downstream,
      ...(row.removalPolicy ? { removalPolicy: row.removalPolicy } : {}),
    };
    yield* store.set({ stack: dispatcher, stage: legacyStage, fqn: row.fqn, value: settled });
    settledIds.push(row.fqn);
  }
  return settledIds;
});

const physicalNameKeys = ["functionName", "roleName", "queueName", "logGroupName", "scheduleName", "alarmName", "bucketName", "distributionId", "keyId"];
const physicalName = (row: ResourceState) => {
  const attr = row.status === "updating" ? row.old.attr : "attr" in row ? row.attr : undefined;
  const found = Object.entries(attr ?? {}).find(([key, value]) => physicalNameKeys.includes(key) && typeof value === "string")?.[1];
  return typeof found === "string" ? found : "(no recorded physical name)";
};

export type RetireMode = "preview" | "apply";
interface RetirementItem {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly status: ResourceState["status"];
  readonly action: "delete" | "orphaned";
}
// Plans the destroy, which takes the stack/stage lease for the surrounding scope, and reads the
// account and region the legacy identities are checked against.
const open = Effect.fn(function* (stack: ConfiguredStack<unknown, never>) {
  const plan = yield* Alchemist.plan({ stack, stage: legacyStage, operation: "destroy" });
  const store = yield* Effect.flatten(State).pipe(Effect.provide(plan.context));
  const { accountId, region } = yield* AWSEnvironment.current;
  return { plan, store, inventory: inventoryOf(stack.stackName, { accountId, region }) };
});
const items = (plan: Alchemist.StackPlan): RetirementItem[] => Object.values(plan.native.deletions).flatMap((row) => (row ? [{ id: row.resource.FQN, type: row.resource.Type, name: physicalName(row.state), status: row.state.status, action: row.action }] : []));

// Settles the legacy dispatcher's interrupted records and returns the ones it settled.
export const settle = Effect.fn(function* (stack: ConfiguredStack<unknown, never>) {
  if (stack.stackName !== dispatcher) return yield* refuse("Only the legacy transcription dispatcher has a settle step");
  return yield* Effect.gen(function* () {
    const { plan, store, inventory } = yield* open(stack);
    return yield* settleLegacyDispatcher(store, inventory).pipe(Effect.provide(plan.context));
  }).pipe(Effect.scoped);
});

// The one retirement entry point. `preview` writes nothing; `apply` releases the retained records and
// then runs the existing destroy. Every target validates its records first; a target with no expected
// inventory refuses any record it holds. Both modes return each resource's type and physical name, so an
// operator sees what goes before it goes.
export const retire = Effect.fn(function* (stack: ConfiguredStack<unknown, never>, mode: RetireMode) {
  if (mode === "apply" && stack.stackName === dispatcher) {
    yield* Effect.gen(function* () {
      const { store, inventory } = yield* open(stack);
      yield* releaseLegacyDispatcher(store, inventory);
    }).pipe(Effect.scoped);
  }
  return yield* Effect.gen(function* () {
    const { plan, store, inventory } = yield* open(stack);
    const rows = yield* readRows(store, stack.stackName);
    yield* validate(rows, inventory);
    yield* requireStable(rows);
    const result = items(plan);
    if (mode === "apply") yield* clearStage(plan);
    return result;
  }).pipe(Effect.scoped);
});
