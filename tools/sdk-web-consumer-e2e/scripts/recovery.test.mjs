import assert from "node:assert/strict";
import { test } from "node:test";
import { waitForRecovery } from "./recovery.mjs";

test("accepts recovery inside the grace period without a reconnecting snapshot", async () => {
  await waitForRecovery({}, async (_page, predicate) => {
    assert.equal(predicate({ state: "live" }), true, "fast recovery stays live");
  });
});

test("waits for live after observing slower recovery", async () => {
  const states = ["reconnecting", "live"];
  await waitForRecovery({}, async (_page, predicate) => {
    assert.equal(predicate({ state: states.shift() }), true);
  });
  assert.equal(states.length, 0);
});
