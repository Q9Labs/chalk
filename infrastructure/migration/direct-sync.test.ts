import assert from "node:assert/strict";
import { test } from "node:test";
import { interfaceGroups } from "../providers/aws-network-interface-security-group.ts";
import { validateDirectSyncResourceSet } from "./direct-sync.ts";

test("attaching and detaching one group preserves the interface's other groups", () => {
  assert.deepEqual(interfaceGroups(["host", "monitor"], "direct", true), ["host", "monitor", "direct"]);
  assert.deepEqual(interfaceGroups(["host", "direct", "monitor"], "direct", true), ["host", "direct", "monitor"]);
  assert.deepEqual(interfaceGroups(["host", "direct", "monitor"], "direct", false), ["host", "monitor"]);
  assert.deepEqual(interfaceGroups(["host", "monitor"], "direct", false), ["host", "monitor"]);
  assert.throws(() => interfaceGroups(["direct"], "direct", false), /last security group/);
});

test("direct-sync seed refuses incomplete or unknown resource sets before cloud access", () => {
  assert.throws(() => validateDirectSyncResourceSet([]), /Unexpected direct-sync resource set/);
  assert.throws(() => validateDirectSyncResourceSet([{ mode: "managed", type: "unknown", name: "resource", instances: [] }]), /Unexpected direct-sync resource set/);
});
