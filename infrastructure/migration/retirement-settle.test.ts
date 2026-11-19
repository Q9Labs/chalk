import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResourceState } from "alchemy/State";
import * as Exit from "effect/Exit";
import { account, created, seeded, inventorySize, setup, failureText, snapshot, interrupted, controlEndpoint } from "./retirement-fixtures.ts";

test("an updated record is a stable finished state, so preview and apply need no settle", async () => {
  const rows = seeded().map((row): ResourceState => (row.logicalId === "Reconcile" ? { ...row, status: "updated" } : row));
  const { run, cloud, remaining } = setup(rows);
  const preview = await run("preview");
  assert.ok(Exit.isSuccess(preview), failureText(preview));
  const exit = await run("apply");
  assert.ok(Exit.isSuccess(exit), failureText(exit));
  assert.equal(cloud.deleted.length, inventorySize);
  assert.equal(remaining().length, 0);
});

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
  cloud.live.set("Reconcile", { marker: "live", state: "DISABLED", scheduleName: "chalk-nightly-transcription-reconcile", groupName: "chalk-nightly" });
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

test("a target without an expected inventory refuses any record, so a CloudFront distribution is never destroyed", async () => {
  const { cloud, run, state } = controlEndpoint([created("Cdn", "AWS.CloudFront.Distribution", {}, { distributionId: "E123EXAMPLE", distributionArn: `arn:aws:cloudfront::${account}:distribution/E123EXAMPLE` })]);
  for (const mode of ["preview", "apply"] as const) assert.match(failureText(await run(mode)), /Unexpected record Cdn/);
  assert.equal(cloud.deleted.length, 0);
  assert.equal(Object.keys(state["recording-control-address"]?.nightly ?? {}).length, 1);
});

test("a target without an expected inventory passes when it holds no record", async () => {
  const { run } = controlEndpoint([]);
  const exit = await run("preview");
  assert.ok(Exit.isSuccess(exit), failureText(exit));
  assert.deepEqual(exit.value, []);
});
