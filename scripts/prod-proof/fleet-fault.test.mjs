import assert from "node:assert/strict";
import test from "node:test";
import { FaultPulse } from "./fleet-fault.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));

function pulseWith(events) {
  let clock = 0;
  return new FaultPulse({
    holdMs: 5000,
    now: () => clock,
    sleep: async (ms) => void (clock += ms),
    down: async () => void events.push("down"),
    up: async () => void events.push("up"),
  });
}

test("a pulse waits for every running call to park, blocks the path once, and releases them all after the restore", async () => {
  const events = [];
  const pulse = pulseWith(events);
  const calls = ["a", "b", "c"];
  for (const call of calls) await pulse.enter(call);
  const results = [];
  const running = pulse.run();
  // Two calls park; the pulse must not start until the third does.
  const first = pulse.checkpoint("a", async () => events.push("stall a") && true).then((fault) => results.push(["a", fault]));
  const second = pulse.checkpoint("b", async () => events.push("stall b") && true).then((fault) => results.push(["b", fault]));
  await tick();
  assert.deepEqual(events, []);
  const third = pulse.checkpoint("c", async () => events.push("stall c") && true).then((fault) => results.push(["c", fault]));
  const outcome = await running;
  await Promise.all([first, second, third]);
  assert.deepEqual(events.slice(0, 1), ["down"]);
  assert.equal(events.filter((event) => event === "up").length, 1);
  assert.equal(events.indexOf("up") > events.lastIndexOf("stall c"), true, "the path is restored only after every call proved its stall");
  assert.equal(outcome.calls, 3);
  assert.equal(results.length, 3);
  assert.ok(results.every(([, fault]) => fault.stalled === true && fault.restoredAt === 5000));
});

test("a call that checks in with no pulse pending continues at once", async () => {
  const pulse = pulseWith([]);
  await pulse.enter("a");
  assert.equal(await pulse.checkpoint("a", async () => true), undefined);
});

test("a call that starts while a pulse is pending waits until the path is back", async () => {
  const events = [];
  const pulse = pulseWith(events);
  await pulse.enter("a");
  const running = pulse.run();
  let entered = false;
  const late = pulse.enter("b").then(() => (entered = true));
  await tick();
  assert.equal(entered, false);
  await Promise.all([pulse.checkpoint("a", async () => true), running]);
  await late;
  assert.equal(entered, true);
});

test("a call that leaves while the pulse waits no longer holds it back", async () => {
  const pulse = pulseWith([]);
  await pulse.enter("a");
  await pulse.enter("b");
  const running = pulse.run();
  const parked = pulse.checkpoint("a", async () => true);
  pulse.leave("b");
  await Promise.all([parked, running]);
});

test("a failed restore still releases the calls and rejects the pulse", async () => {
  const pulse = new FaultPulse({ holdMs: 5000, now: () => 0, sleep: async () => {}, down: async () => {}, up: async () => Promise.reject(new Error("up failed")) });
  await pulse.enter("a");
  const running = pulse.run();
  const parked = pulse.checkpoint("a", async () => true);
  await assert.rejects(running, /up failed/);
  assert.equal((await parked).stalled, true);
  assert.equal(pulse.pending, false);
});
