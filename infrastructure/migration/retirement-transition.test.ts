import assert from "node:assert/strict";
import { test } from "node:test";
import * as Alchemist from "alchemy/Alchemist";
import type { CreatedResourceState, ResourceState } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { clearStage } from "../releases/cleanup.ts";
import { stackName, fn, account, region, queueAttr, tags, created, seeded, inventorySize, setup, failureText, snapshot, withAttr, survivors } from "./retirement-fixtures.ts";

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
  assert.ok(
    exit.value.every((item) => item.action === "orphaned"),
    "retained records are shown as not yet destroyable",
  );
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
  ["a production-named queue", (rows) => rows.map((row) => (row.logicalId === "AsyncFailure" ? { ...row, attr: queueAttr("chalk-production-transcription-dispatcher-async-failure") } : row)), /outside the legacy Nightly naming/],
  // The upstream SQS provider deletes by queueUrl, so the URL and ARN are validated, not only the name.
  ["a queue whose URL names another account", (rows) => withAttr(rows, "AsyncFailure", { queueUrl: `https://sqs.${region}.amazonaws.com/111111111111/${fn}-async-failure` }), /unexpected queueUrl/],
  ["a queue whose URL names another region", (rows) => withAttr(rows, "AsyncFailure", { queueUrl: `https://sqs.us-east-1.amazonaws.com/${account}/${fn}-async-failure` }), /unexpected queueUrl/],
  ["a queue whose URL names another queue", (rows) => withAttr(rows, "SchedulerDlq", { queueUrl: `https://sqs.${region}.amazonaws.com/${account}/chalk-production-api-dlq` }), /unexpected queueUrl/],
  ["a queue whose ARN names another account", (rows) => withAttr(rows, "SchedulerDlq", { queueArn: `arn:aws:sqs:${region}:111111111111:${fn}-scheduler-dlq` }), /unexpected queueArn/],
  ["a queue without a URL", (rows) => rows.map((row) => (row.logicalId === "AsyncFailure" ? { ...row, attr: { queueName: `${fn}-async-failure` } } : row)), /has no queueUrl/],
  ["an unrelated Nightly permission", (rows) => withAttr(rows, "ControlApiPermission", { functionName: "chalk-nightly-other-api" }), /unexpected functionName/],
  ["a permission with another statement ID", (rows) => withAttr(rows, "SchedulerPermission", { statementId: "AllowSomethingElse" }), /unexpected statementId/],
  ["a permission on a function in another account", (rows) => withAttr(rows, "SchedulerPermission", { functionName: `arn:aws:lambda:${region}:111111111111:function:${fn}` }), /unexpected functionName/],
  ["a schedule with another name", (rows) => withAttr(rows, "Reconcile", { scheduleName: "chalk-nightly-other-reconcile" }), /unexpected scheduleName/],
  ["a schedule in another group", (rows) => withAttr(rows, "Reconcile", { groupName: "default" }), /unexpected groupName/],
  ["a permission outside the Nightly function", (rows) => rows.map((row) => (row.logicalId === "ControlApiPermission" ? { ...row, attr: { statementId: "AllowControlApiWake", functionName: "chalk-production-api" } } : row)), /outside the legacy Nightly naming/],
  ["a protected record", (rows) => rows.map((row) => (row.logicalId === "Logs" ? { ...row, removalPolicy: "protect" } : row)), /protect/],
  ["a function record with another name", (rows) => withAttr(rows, "Function", { functionName: "chalk-nightly-other" }), /unexpected functionName/],
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

test("a valid partial inventory left by an earlier crash still retires, deleting only the survivors", async () => {
  const { run, cloud, remaining } = setup(survivors("Reconcile", "SchedulerPermission", "Errors"));
  assert.ok(Exit.isSuccess(await run("preview")));
  const exit = await run("apply");
  assert.ok(Exit.isSuccess(exit), failureText(exit));
  assert.deepEqual([...cloud.deleted].sort(), ["Errors", "Reconcile", "SchedulerPermission"]);
  assert.equal(remaining().length, 0);
});

test("a permission-only inventory is validated by its own identity, so an unrelated function is refused", async () => {
  const rows = withAttr(survivors("ControlApiPermission"), "ControlApiPermission", { functionName: "chalk-nightly-other-api" });
  const { run, cloud, remaining } = setup(rows);
  const before = snapshot(remaining());
  for (const mode of ["preview", "apply"] as const) assert.match(failureText(await run(mode)), /unexpected functionName/);
  assert.equal(snapshot(remaining()), before);
  assert.equal(cloud.deleted.length, 0);
});
