import assert from "node:assert/strict";
import { test } from "node:test";
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
import { clearStage } from "../releases/cleanup.ts";
import { retire, settle, type RetireMode } from "./retirement-transition.ts";

const stackName = "transcription-dispatcher";
const fn = "chalk-nightly-transcription-dispatcher";
const arn = `arn:aws:lambda:ap-southeast-1:000000000000:function:${fn}`;
const tags = { chalk_environment: "nightly", chalk_component: "transcription-dispatcher" };
type Rows = Record<string, ResourceState>;

const created = (logicalId: string, resourceType: string, props: Record<string, unknown>, attr: Record<string, unknown>): CreatedResourceState => ({
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
const seeded = (): CreatedResourceState[] => [
  created("ExecutionRole", "AWS.IAM.Role", { tags }, { roleName: `${fn}-execution` }),
  created("SchedulerRole", "AWS.IAM.Role", {}, { roleName: `${fn}-scheduler` }),
  created("AsyncFailure", "AWS.SQS.Queue", { tags }, { queueName: `${fn}-async-failure` }),
  created("SchedulerDlq", "AWS.SQS.Queue", { tags }, { queueName: `${fn}-scheduler-dlq` }),
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

interface Fake extends Resource<string, { readonly marker?: string }, { readonly marker: string; readonly state?: string }> {}
// The cloud boundary: one counting provider per legacy resource type. The planner, the state store,
// cleanup and the transition are the real code.
function fakeCloud(types: readonly string[]) {
  const deleted: string[] = [];
  const failOnce = new Set<string>();
  const missing = new Set<string>();
  const live = new Map<string, { readonly marker: string; readonly state?: string }>();
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
const inventorySize = seeded().length;
const legacyTypes = [...new Set(seeded().map((row) => row.resourceType)), "AWS.S3.Bucket", "AWS.KMS.Key"];

function setup(rows: readonly ResourceState[]) {
  const state: Record<string, Record<string, Rows>> = { [stackName]: { nightly: rowsOf(rows) } };
  const cloud = fakeCloud(legacyTypes);
  const stack = Alchemy.Stack(stackName, { providers: cloud.layer, state: inMemoryState(state, { [stackName]: { nightly: { saved: true } } }) }, Effect.void);
  const run = (mode: RetireMode) => Effect.runPromiseExit(retire(stack, mode).pipe(Effect.provide(Alchemist.layer())));
  const settleRun = () => Effect.runPromiseExit(settle(stack).pipe(Effect.provide(Alchemist.layer())));
  const remaining = () => Object.values(state[stackName]?.nightly ?? {});
  return { state, cloud, stack, run, settleRun, remaining };
}
const failureText = (exit: Exit.Exit<unknown, unknown>) => (Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "");
const snapshot = (rows: readonly ResourceState[]) => JSON.stringify(rows);

test("baseline: cleanup refuses the seeded retained records, which is why a transition is needed", async () => {
  const { stack, cloud } = setup(seeded());
  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      yield* clearStage(yield* Alchemist.plan({ stack, stage: "nightly", operation: "destroy" }));
    }).pipe(Effect.provide(Alchemist.layer()), Effect.scoped),
  );
  assert.match(failureText(exit), /retained resources/);
  assert.equal(cloud.deleted.length, 0);
});

test("preview lists type and physical name for every record and writes nothing", async () => {
  const { run, cloud, remaining } = setup(seeded());
  const before = snapshot(remaining());
  const exit = await run("preview");
  assert.ok(Exit.isSuccess(exit), failureText(exit));
  const names = exit.value.map((item) => `${item.type} ${item.name}`);
  assert.equal(names.length, inventorySize);
  assert.ok(names.includes("Chalk.Lambda.VersionedFunction chalk-nightly-transcription-dispatcher"));
  assert.ok(names.includes("AWS.Scheduler.Schedule chalk-nightly-transcription-reconcile"));
  assert.ok(exit.value.every((item) => item.action === "orphaned"), "retained records are shown as not yet destroyable");
  assert.equal(snapshot(remaining()), before);
  assert.equal(cloud.deleted.length, 0);
});

test("apply releases and destroys exactly the legacy inventory once, and leaves no state", async () => {
  const { run, cloud, remaining, state } = setup(seeded());
  const exit = await run("apply");
  assert.ok(Exit.isSuccess(exit), failureText(exit));
  assert.equal(cloud.deleted.length, inventorySize);
  assert.equal(new Set(cloud.deleted).size, inventorySize);
  assert.equal(remaining().length, 0);
  assert.equal(state[stackName]?.nightly, undefined);
  const again = await run("apply");
  assert.ok(Exit.isSuccess(again), "a retry after completion is a no-op");
  assert.equal(cloud.deleted.length, inventorySize);
});

for (const released of [0, 1, 6, 13, 14])
  test(`crash during the release step: ${released} records already released, retry finishes`, async () => {
    const rows = seeded().map((row, index): CreatedResourceState => (index < released ? { ...row, removalPolicy: "destroy" } : row));
    const { run, cloud, remaining } = setup(rows);
    const exit = await run("apply");
    assert.ok(Exit.isSuccess(exit), failureText(exit));
    assert.equal(cloud.deleted.length, inventorySize);
    assert.equal(remaining().length, 0);
  });

test("crash during the destroy: the retry resumes and every resource is deleted once", async () => {
  const { run, cloud, remaining } = setup(seeded());
  cloud.failOnce.add("Logs");
  const first = await run("apply");
  assert.ok(Exit.isFailure(first));
  assert.match(failureText(first), /injected crash deleting Logs/);
  const partial = remaining();
  assert.ok(partial.length > 0 && partial.every((row) => row.removalPolicy === "destroy"), "only released records are left, all destroyable");
  const second = await run("apply");
  assert.ok(Exit.isSuccess(second), failureText(second));
  assert.equal(cloud.deleted.length, inventorySize);
  assert.equal(new Set(cloud.deleted).size, inventorySize);
  assert.equal(remaining().length, 0);
});

const refusals: ReadonlyArray<readonly [string, (rows: CreatedResourceState[]) => ResourceState[], RegExp]> = [
  ["an unknown logical ID", (rows) => [...rows, created("Surprise", "AWS.IAM.Role", { tags }, { roleName: "chalk-nightly-surprise" })], /Unexpected record Surprise/],
  ["a borrowed artifacts bucket", (rows) => [...rows, created("Artifacts", "AWS.S3.Bucket", {}, { bucketName: "chalk-nightly-artifacts" })], /Unexpected record Artifacts/],
  ["a borrowed KMS key", (rows) => [...rows, created("Key", "AWS.KMS.Key", {}, { keyId: "key" })], /Unexpected record Key/],
  ["a known ID with another type", (rows) => rows.map((row) => (row.logicalId === "Errors" ? { ...row, resourceType: "AWS.S3.Bucket" } : row)), /not the expected AWS.CloudWatch.Alarm/],
  ["a record without the saved Nightly tag", (rows) => rows.map((row) => (row.logicalId === "Function" ? { ...row, props: { tags: { ...tags, chalk_environment: "production" } } } : row)), /saved Nightly environment tag/],
  ["a production-named queue", (rows) => rows.map((row) => (row.logicalId === "AsyncFailure" ? { ...row, attr: { queueName: "chalk-production-transcription-dispatcher-async-failure" } } : row)), /outside the legacy Nightly naming/],
  ["a permission outside the Nightly function", (rows) => rows.map((row) => (row.logicalId === "ControlApiPermission" ? { ...row, attr: { statementId: "AllowControlApiWake", functionName: "chalk-production-api" } } : row)), /outside the legacy Nightly naming/],
  ["a protected record", (rows) => rows.map((row) => (row.logicalId === "Logs" ? { ...row, removalPolicy: "protect" } : row)), /protect/],
  ["records naming two functions", (rows) => rows.map((row) => (row.logicalId === "Function" ? { ...row, attr: { functionName: "chalk-nightly-other" } } : row)), /more than one dispatcher function/],
];
for (const [label, mutate, message] of refusals)
  test(`refuses ${label} before any write or delete`, async () => {
    const { run, cloud, remaining } = setup(mutate(seeded()));
    const before = snapshot(remaining());
    for (const mode of ["preview", "apply"] as const) {
      const exit = await run(mode);
      assert.match(failureText(exit), message);
    }
    assert.equal(snapshot(remaining()), before);
    assert.equal(cloud.deleted.length, 0);
  });

const interrupted = (rows: CreatedResourceState[]): ResourceState[] =>
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

test("an updating record fails closed in preview and apply, naming the recovery step", async () => {
  const { run, cloud, remaining } = setup(interrupted(seeded()));
  const before = snapshot(remaining());
  for (const mode of ["preview", "apply"] as const) {
    const exit = await run(mode);
    assert.match(failureText(exit), /Reconcile \(updating\) are not stable/);
    assert.match(failureText(exit), /pnpm infra retire transcription-dispatcher --settle/);
  }
  assert.equal(snapshot(remaining()), before);
  assert.equal(cloud.deleted.length, 0);
});

test("settle records the live resource as created, deletes nothing, and unblocks retirement", async () => {
  const { run, settleRun, cloud, remaining } = setup(interrupted(seeded()));
  cloud.live.set("Reconcile", { marker: "live", state: "DISABLED" });
  const settled = await settleRun();
  assert.ok(Exit.isSuccess(settled), failureText(settled));
  assert.deepEqual(settled.value, ["Reconcile"]);
  assert.equal(cloud.deleted.length, 0);
  const row = remaining().find((candidate) => candidate.fqn === "Reconcile");
  assert.equal(row?.status, "created");
  assert.equal(row?.removalPolicy, "retain");
  assert.ok(Exit.isSuccess(await settleRun()), "settling again changes nothing");
  const exit = await run("apply");
  assert.ok(Exit.isSuccess(exit), failureText(exit));
  assert.equal(cloud.deleted.length, inventorySize);
  assert.equal(remaining().length, 0);
});

test("settle refuses a record whose live resource is gone", async () => {
  const { settleRun, cloud, remaining } = setup(interrupted(seeded()));
  cloud.missing.add("Reconcile");
  const before = snapshot(remaining());
  const exit = await settleRun();
  assert.match(failureText(exit), /Live Reconcile was not found/);
  assert.equal(snapshot(remaining()), before);
});

test("settle refuses a record that is not an interrupted update", async () => {
  const rows = seeded().map((row): ResourceState => (row.logicalId === "Reconcile" ? { ...row, status: "creating" } : row));
  const { settleRun, remaining } = setup(rows);
  const before = snapshot(remaining());
  assert.match(failureText(await settleRun()), /Reconcile is creating/);
  assert.equal(snapshot(remaining()), before);
});
