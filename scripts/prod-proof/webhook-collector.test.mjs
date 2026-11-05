import assert from "node:assert/strict";
import test from "node:test";
import { startCollector } from "./webhook-collector.mjs";
import { CatcherRateLimited } from "./webhook-transport.mjs";

const pauses = { poll: 1, rateLimited: 1 };

async function until(condition) {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 1));
}

test("a rate-limited poll is skipped and later polls keep running", async () => {
  const receiver = {};
  const run = { resources: [] };
  let polls = 0;
  startCollector(
    run,
    receiver,
    async () => {
      if (++polls === 1) throw new CatcherRateLimited("GET");
    },
    pauses,
  );
  await until(() => polls >= 3 || receiver.failure);
  await run.resources[0].dispose();
  assert.equal(receiver.failure, undefined);
});

test("any other poll error still fails the receiver", async () => {
  const receiver = {};
  const run = { resources: [] };
  let polls = 0;
  startCollector(
    run,
    receiver,
    async () => {
      if (++polls === 2) throw new Error("Webhook Tenant does not match this run");
    },
    pauses,
  );
  await until(() => receiver.failure);
  await run.resources[0].dispose();
  assert.equal(receiver.failure, "Webhook Tenant does not match this run");
});
