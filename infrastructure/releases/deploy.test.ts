import assert from "node:assert/strict";
import { test } from "node:test";
import { type BootstrapRow, bootstrapMatches } from "./deploy.ts";

const renderer: Array<[string, string]> = [
  ["ExecutionRole", "AWS.IAM.Role"],
  ["Logs", "AWS.Logs.LogGroup"],
  ["FailureLogMetric", "AWS.Logs.MetricFilter"],
  ["Function", "Chalk.Lambda.VersionedFunction"],
  ["Errors", "AWS.CloudWatch.Alarm"],
  ["Throttles", "AWS.CloudWatch.Alarm"],
  ["AsyncEventsDropped", "AWS.CloudWatch.Alarm"],
];

function rows(entries: Array<[string, string]>, action = "create"): BootstrapRow[] {
  return entries.map(([FQN, Type]) => ({ action, resource: { FQN, Type } }));
}

test("renderer bootstrap accepts exactly the isolated resource set", () => {
  assert.equal(bootstrapMatches("document-renderer", rows(renderer)), true);
});

test("renderer bootstrap accepts the optional control API permission", () => {
  assert.equal(bootstrapMatches("document-renderer", rows([...renderer, ["ControlApiPermission", "AWS.Lambda.Permission"]])), true);
});

test("renderer bootstrap refuses a missing required resource", () => {
  assert.equal(bootstrapMatches("document-renderer", rows(renderer.filter(([FQN]) => FQN !== "Logs"))), false);
});

test("renderer bootstrap refuses an unexpected resource", () => {
  assert.equal(bootstrapMatches("document-renderer", rows([...renderer, ["Extra", "AWS.Lambda.Function"]])), false);
});

test("renderer bootstrap refuses a non-create action", () => {
  assert.equal(bootstrapMatches("document-renderer", rows(renderer, "update")), false);
});

test("renderer bootstrap refuses a resource with the wrong type", () => {
  assert.equal(bootstrapMatches("document-renderer", rows(renderer.map(([FQN, Type]) => (FQN === "Logs" ? [FQN, "AWS.IAM.Role"] : [FQN, Type]) as [string, string]))), false);
});

test("renderer bootstrap refuses a plan that holds only the optional permission", () => {
  assert.equal(bootstrapMatches("document-renderer", rows([["ControlApiPermission", "AWS.Lambda.Permission"]])), false);
});
