import * as Alchemist from "alchemy/Alchemist";
import { stripUnowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { isResourceState, State, type StateService } from "alchemy/State";
import type { Attr, CreatedResourceState, Props, ResourceState } from "alchemy/State";
import type { ConfiguredStack } from "alchemy/Stack";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { clearStage } from "../releases/cleanup.ts";

// The seeded legacy Nightly dispatcher records all carry removalPolicy "retain", which the planner
// turns into `orphaned` nodes that cleanup refuses. This module is the one explicit transition that
// makes exactly the expected legacy inventory destroyable. Each step validates every record first,
// writes one record at a time, and is a pure function of the records, so a retry after a crash at
// any point ends in the same state. Every step plans first, so it holds the stack/stage lease; the
// lease is bound to the step's scope, so the release step and the destroy step are separate scopes
// and the destroy step validates the inventory again.
export const legacyStage = "nightly";
const dispatcher = "transcription-dispatcher";
const nightlyPrefix = "chalk-nightly-";

interface Entry {
  readonly type: string;
  // The attribute that holds the physical name, and what surrounds the function name in it.
  readonly field: string;
  readonly prefix: string;
  readonly suffix: string;
  readonly tagged: boolean;
  readonly statementId?: string;
}
const entry = (type: string, field: string, suffix: string, tagged = false, prefix = ""): Entry => ({ type, field, prefix, suffix, tagged });
const permission = (statementId: string): Entry => ({ type: "AWS.Lambda.Permission", field: "functionName", prefix: "", suffix: "", tagged: false, statementId });
// The legacy naming contract: the types and logical IDs of transcription-dispatcher/policy.ts and the
// names of transcription-dispatcher/resources.ts as they were seeded for Nightly.
const inventory: Readonly<Record<string, Entry>> = {
  ExecutionRole: entry("AWS.IAM.Role", "roleName", "-execution", true),
  SchedulerRole: entry("AWS.IAM.Role", "roleName", "-scheduler"),
  AsyncFailure: entry("AWS.SQS.Queue", "queueName", "-async-failure", true),
  SchedulerDlq: entry("AWS.SQS.Queue", "queueName", "-scheduler-dlq", true),
  Logs: entry("AWS.Logs.LogGroup", "logGroupName", "", true, "/aws/lambda/"),
  Function: entry("Chalk.Lambda.VersionedFunction", "functionName", "", true),
  Reconcile: entry("AWS.Scheduler.Schedule", "scheduleName", "", false, ""),
  SchedulerPermission: permission("AllowEventBridgeSchedulerWake"),
  ControlApiPermission: permission("AllowControlApiWake"),
  Errors: entry("AWS.CloudWatch.Alarm", "alarmName", "-errors"),
  Throttles: entry("AWS.CloudWatch.Alarm", "alarmName", "-throttles"),
  AsyncEventsDropped: entry("AWS.CloudWatch.Alarm", "alarmName", "-async-events-dropped"),
  AsyncFailureDepth: entry("AWS.CloudWatch.Alarm", "alarmName", "-async-failure-depth"),
  SchedulerTargetErrors: entry("AWS.CloudWatch.Alarm", "alarmName", "-scheduler-target-errors"),
};
const scheduleGroupPrefix = "chalk-nightly";

const attrString = Effect.fn(function* (attr: Attr, key: string, fqn: string) {
  const value = Object.entries(attr).find(([name]) => name === key)?.[1];
  if (typeof value !== "string") return yield* Effect.die(`Record ${fqn} has no ${key}; retirement refused`);
  return value;
});
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

const readRows = Effect.fn(function* (store: StateService) {
  const identity = { stack: dispatcher, stage: legacyStage };
  const rows: ResourceState[] = [];
  for (const fqn of yield* store.list(identity)) {
    const row = yield* store.get({ ...identity, fqn });
    if (!isResourceState(row)) return yield* Effect.die(`Record ${fqn} is not a resource; retirement refused`);
    rows.push(row);
  }
  return rows;
});

// Every record must be exactly one expected legacy resource. A bucket, a KMS key, a retained shared
// resource or a record from another environment is refused: retirement deletes only what the Nightly
// dispatcher stack itself created.
const validate = Effect.fn(function* (rows: readonly ResourceState[]) {
  const functionNames = new Set<string>();
  for (const row of rows) {
    const expected = row.fqn === row.logicalId ? Object.entries(inventory).find(([id]) => id === row.logicalId)?.[1] : undefined;
    if (!expected) return yield* Effect.die(`Unexpected record ${row.fqn} (${row.resourceType}); only the legacy Nightly dispatcher inventory may be retired`);
    if (row.resourceType !== expected.type) return yield* Effect.die(`Record ${row.fqn} is ${row.resourceType}, not the expected ${expected.type}; retirement refused`);
    if (row.removalPolicy !== undefined && row.removalPolicy !== "retain" && row.removalPolicy !== "destroy") return yield* Effect.die(`Record ${row.fqn} has removal policy ${row.removalPolicy}; retirement refused`);
    const applied = lastApplied(row);
    if (!applied) return yield* Effect.die(`Record ${row.fqn} is ${row.status}; retirement cannot reason about it. Inspect the live resource by hand`);
    if (row.status === "deleting" && !resumable(row)) return yield* Effect.die(`Record ${row.fqn} is deleting without having been released by this retirement; inspect the live resource by hand`);
    if (expected.tagged && row.status !== "deleting" && !taggedNightly(applied.props)) return yield* Effect.die(`Record ${row.fqn} does not carry the saved Nightly environment tag; retirement refused`);
    const name = yield* attrString(applied.attr, expected.field, row.fqn);
    if (expected.statementId !== undefined) {
      if ((yield* attrString(applied.attr, "statementId", row.fqn)) !== expected.statementId) return yield* Effect.die(`Record ${row.fqn} has an unexpected statement ID; retirement refused`);
      // The permission names its function by name or ARN.
      if (!(name.split(":").pop() ?? "").startsWith(nightlyPrefix)) return yield* Effect.die(`Record ${row.fqn} grants a function outside the legacy Nightly naming; retirement refused`);
      continue;
    }
    if (row.logicalId === "Reconcile") {
      if (!(yield* attrString(applied.attr, "groupName", row.fqn)).startsWith(scheduleGroupPrefix) || !name.startsWith(nightlyPrefix)) return yield* Effect.die(`Record ${row.fqn} is outside the legacy Nightly naming; retirement refused`);
      continue;
    }
    if (!name.startsWith(expected.prefix + nightlyPrefix) || !name.endsWith(expected.suffix)) return yield* Effect.die(`Record ${row.fqn} is ${name}, outside the legacy Nightly naming; retirement refused`);
    functionNames.add(name.slice(expected.prefix.length, name.length - expected.suffix.length));
  }
  if (functionNames.size > 1) return yield* Effect.die("Records name more than one dispatcher function; retirement refused");
});

// Only a record the last apply finished is safe to act on. The message says how to recover.
const requireStable = Effect.fn(function* (rows: readonly ResourceState[]) {
  const unstable = rows.filter((row) => row.status !== "created" && !resumable(row));
  if (unstable.length)
    return yield* Effect.die(
      `Records ${unstable.map((row) => `${row.fqn} (${row.status})`).join(", ")} are not stable. Run \`pnpm infra retire transcription-dispatcher --settle\`: it re-reads each live resource and marks an interrupted update created, deleting nothing. Then preview again`,
    );
});

// Make exactly the validated records destroyable, one record at a time.
export const releaseLegacyDispatcher = Effect.fn(function* (store: StateService) {
  const rows = yield* readRows(store);
  yield* validate(rows);
  yield* requireStable(rows);
  for (const row of rows) {
    if (row.removalPolicy === "destroy") continue;
    yield* store.set({ stack: dispatcher, stage: legacyStage, fqn: row.fqn, value: { ...row, removalPolicy: "destroy" } });
  }
});

// Recovery for records a failed apply left updating: confirm the physical resource exists, then record
// what is live as the created state. Deletes nothing; a resource that is gone is refused.
export const settleLegacyDispatcher = Effect.fn(function* (store: StateService) {
  const rows = yield* readRows(store);
  yield* validate(rows);
  const settledIds: string[] = [];
  for (const row of rows) {
    if (row.status === "created" || resumable(row)) continue;
    const applied = lastApplied(row);
    if (!applied?.props || (row.status !== "updating" && row.status !== "updated")) return yield* Effect.die(`Record ${row.fqn} is ${row.status}; only an interrupted update can be settled. Inspect the live resource by hand`);
    const provider = yield* Provider.findProviderByType(row.resourceType);
    if (!provider.read) return yield* Effect.die(`No read method for ${row.resourceType}`);
    const live = yield* provider.read({ id: row.logicalId, fqn: row.fqn, instanceId: row.instanceId, olds: applied.props, output: applied.attr });
    if (!live) return yield* Effect.die(`Live ${row.fqn} was not found; settling would invent a record. Inspect it by hand`);
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
export interface RetirementItem {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly status: ResourceState["status"];
  readonly action: "delete" | "orphaned";
}
// Plans the destroy, which takes the stack/stage lease for the surrounding scope.
const open = Effect.fn(function* (stack: ConfiguredStack<unknown, never>) {
  const plan = yield* Alchemist.plan({ stack, stage: legacyStage, operation: "destroy" });
  const store = yield* Effect.flatten(State).pipe(Effect.provide(plan.context));
  return { plan, store };
});
const items = (plan: Alchemist.StackPlan): RetirementItem[] =>
  Object.values(plan.native.deletions).flatMap((row) => (row ? [{ id: row.resource.FQN, type: row.resource.Type, name: physicalName(row.state), status: row.state.status, action: row.action }] : []));

// Settles the legacy dispatcher's interrupted records and returns the ones it settled.
export const settle = Effect.fn(function* (stack: ConfiguredStack<unknown, never>) {
  if (stack.stackName !== dispatcher) return yield* Effect.die("Only the legacy transcription dispatcher has a settle step");
  return yield* Effect.gen(function* () {
    const { plan, store } = yield* open(stack);
    return yield* settleLegacyDispatcher(store).pipe(Effect.provide(plan.context));
  }).pipe(Effect.scoped);
});

// The one retirement entry point. `preview` writes nothing; `apply` releases the dispatcher inventory
// and then runs the existing destroy. Both return each resource's type and physical name, so an
// operator sees what goes before it goes.
export const retire = Effect.fn(function* (stack: ConfiguredStack<unknown, never>, mode: RetireMode) {
  const legacy = stack.stackName === dispatcher;
  if (mode === "apply" && legacy) {
    yield* Effect.gen(function* () {
      const { store } = yield* open(stack);
      yield* releaseLegacyDispatcher(store);
    }).pipe(Effect.scoped);
  }
  return yield* Effect.gen(function* () {
    const { plan, store } = yield* open(stack);
    if (legacy) {
      const rows = yield* readRows(store);
      yield* validate(rows);
      yield* requireStable(rows);
    }
    const result = items(plan);
    if (mode === "apply") yield* clearStage(plan);
    return result;
  }).pipe(Effect.scoped);
});
