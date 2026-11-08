import assert from "node:assert/strict";
import test from "node:test";
import { slotBlockage, waitForCapture } from "./capture-pool.mjs";

const ours = "recording-ours";
const stale = { job_id: "job-stale", recording_id: "recording-stale", episode_id: "episode-stale", claimed_at: "2026-11-08T01:00:00Z", lease_expires_at: "2026-11-08T01:05:00Z" };
const own = { ...stale, job_id: "job-ours", recording_id: ours, episode_id: "episode-ours" };
const pool = (overrides) => ({ slots_total: 1, slots_used: 1, held: [], held_by_other_tenants: 0, ...overrides });

function fakeTime() {
  let now = 0;
  return { now: () => now, sleep: async (ms) => void (now += ms) };
}
function run(outcome, { ready = () => false, ...options } = {}) {
  const reads = [];
  const time = fakeTime();
  const result = waitForCapture({
    recordingId: ours,
    ready,
    readPool: async () => {
      reads.push(time.now());
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    time,
    ...options,
  });
  return { result, reads, time };
}

test("a slot held by another job fails at the early check with that job's details", async () => {
  const { result, reads, time } = run({ pool: pool({ held: [stale] }) });
  await assert.rejects(result, (error) => {
    assert.equal(error.reason, "capture-slot-held");
    assert.equal(error.message, "capture slot held by job job-stale since 2026-11-08T01:00:00Z (recording recording-stale, Episode episode-stale, lease expires 2026-11-08T01:05:00Z)");
    return true;
  });
  assert.deepEqual(reads, [27_000]);
  assert.equal(time.now(), 27_000);
});

test("a full pool held by other Tenants still fails early, without naming their jobs", async () => {
  const { result } = run({ pool: pool({ held_by_other_tenants: 1 }) });
  await assert.rejects(result, { reason: "capture-slot-held", message: "capture pool full: 1 of 1 slots held by other Tenants' jobs" });
});

test("a slot held by this proof's own job keeps waiting until the timeout", async () => {
  const { result, reads } = run({ pool: pool({ held: [own] }) });
  await assert.rejects(result, { reason: "timeout", message: "Capture ready timed out after 180s; capture pool: 1 of 1 slots in use" });
  assert.deepEqual(reads, [27_000, 180_000]);
});

test("a free pool keeps the existing timeout path", async () => {
  const { result } = run({ pool: pool({ slots_used: 0 }) });
  await assert.rejects(result, { reason: "timeout", message: "Capture ready timed out after 180s; capture pool: 0 of 1 slots in use" });
});

test("an unavailable readout keeps the timeout path and says why", async () => {
  const { result } = run({ unavailable: "API resource not found" });
  await assert.rejects(result, { reason: "timeout", message: "Capture ready timed out after 180s; capture pool readout unavailable: API resource not found" });
});

test("a stale job that appears after the early check fails at the timeout", async () => {
  let reads = 0;
  const time = fakeTime();
  await assert.rejects(
    waitForCapture({
      recordingId: ours,
      ready: () => false,
      readPool: async () => ({ pool: pool({ slots_used: reads++ === 0 ? 0 : 1, held: reads === 1 ? [] : [stale] }) }),
      time,
    }),
    { reason: "capture-slot-held" },
  );
});

test("readiness before the early check never reads the pool", async () => {
  const { result, reads } = run({ pool: pool({ held: [stale] }) }, { ready: () => true });
  await result;
  assert.deepEqual(reads, []);
});

test("a pool with free slots or no slots is not a blockage", () => {
  assert.equal(slotBlockage(pool({ slots_total: 2, slots_used: 1, held: [stale] }), ours), undefined);
  assert.equal(slotBlockage(pool({ slots_total: 0, slots_used: 0 }), ours), undefined);
});

test("the oldest foreign hold is named and the rest are counted", () => {
  const second = { ...stale, job_id: "job-second" };
  assert.match(slotBlockage(pool({ slots_total: 2, slots_used: 2, held: [stale, second] }), ours), /^capture slot held by job job-stale .*\(\+1 more\)$/);
});
