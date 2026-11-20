import assert from "node:assert/strict";
import { test } from "node:test";
import { interfaceGroups } from "./aws-network-interface-security-group.ts";

test("attaching and detaching one group preserves the interface's other groups", () => {
  assert.deepEqual(interfaceGroups(["host", "monitor"], "direct", true), ["host", "monitor", "direct"]);
  assert.deepEqual(interfaceGroups(["host", "direct", "monitor"], "direct", true), ["host", "direct", "monitor"]);
  assert.deepEqual(interfaceGroups(["host", "direct", "monitor"], "direct", false), ["host", "monitor"]);
  assert.deepEqual(interfaceGroups(["host", "monitor"], "direct", false), ["host", "monitor"]);
  assert.throws(() => interfaceGroups(["direct"], "direct", false), /last security group/);
});
