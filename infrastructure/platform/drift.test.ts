import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyDrift } from "./drift.ts";

const record = (status: "in-sync" | "drifted" | "missing" | "skipped") => ({ fqn: "Queue", logicalId: "Queue", resourceType: "AWS.SQS.Queue", status });

test("a record the check skipped is never clean", () => {
  assert.equal(classifyDrift([record("in-sync"), record("skipped")]), "check-failed");
});

test("only records that were all compared and matched are clean", () => {
  assert.equal(classifyDrift([record("in-sync"), record("in-sync")]), "clean");
  assert.equal(classifyDrift([]), "clean");
});

test("a changed or missing resource is drift even when another record was skipped", () => {
  assert.equal(classifyDrift([record("drifted")]), "drift");
  assert.equal(classifyDrift([record("skipped"), record("missing")]), "drift");
});
