import assert from "node:assert/strict";
import test from "node:test";
import { checkCaptureSlotFree, slotBlockage, waitForCapture } from "./capture-pool.mjs";

const ours = "recording-ours";
// The 2026-11-08 nightly case: Capture job e8d1e497 of the 1 h Episode fdea4ab9 was healthy and renewed
// its lease until the recorder's duration_limit, so it held the only slot for an hour (REPORT.md in the
// nightly-capture-slot investigation). Ids and the single slot come from that report; the response keys are
// the ones apps/api/internal/httpapi/recording_capture_pool.go returns.
// Not recorded there, so these two values are placeholders: the job's last claim time (the job row was
// created 16:25:26.431829Z and re-leased once; this is its creation time) and its lease expiry (cleared
// when the job succeeded at 17:25:27.5Z). The optional observed_at is left out.
const nightlyHold = {
  job_id: "e8d1e497-54ae-420e-be02-7ef77059cc82",
  recording_id: "2a6bacc0-04af-53ed-bfcd-a16c310bcfcb",
  episode_id: "fdea4ab9-1c5f-417e-a8d5-31f2286f1b40",
  claimed_at: "2026-11-08T16:25:26.431829Z",
  lease_expires_at: "2026-11-08T17:00:00Z",
};
const own = { ...nightlyHold, job_id: "job-ours", recording_id: ours, episode_id: "episode-ours" };
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
  const { result, reads, time } = run({ pool: pool({ held: [nightlyHold] }) });
  await assert.rejects(result, (error) => {
    assert.equal(error.reason, "capture-slot-held");
    assert.equal(error.message, "capture slot held by job e8d1e497-54ae-420e-be02-7ef77059cc82 since 2026-11-08T16:25:26.431829Z (recording 2a6bacc0-04af-53ed-bfcd-a16c310bcfcb, Episode fdea4ab9-1c5f-417e-a8d5-31f2286f1b40, lease expires 2026-11-08T17:00:00Z)");
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

test("a job that appears after the early check fails at the timeout", async () => {
  let reads = 0;
  const time = fakeTime();
  await assert.rejects(
    waitForCapture({
      recordingId: ours,
      ready: () => false,
      readPool: async () => ({ pool: pool({ slots_used: reads++ === 0 ? 0 : 1, held: reads === 1 ? [] : [nightlyHold] }) }),
      time,
    }),
    { reason: "capture-slot-held" },
  );
});

test("readiness before the early check never reads the pool", async () => {
  const { result, reads } = run({ pool: pool({ held: [nightlyHold] }) }, { ready: () => true });
  await result;
  assert.deepEqual(reads, []);
});

test("a pool with free slots or no slots is not a blockage", () => {
  assert.equal(slotBlockage(pool({ slots_total: 2, slots_used: 1, held: [nightlyHold] }), ours), undefined);
  assert.equal(slotBlockage(pool({ slots_total: 0, slots_used: 0 }), ours), undefined);
});

test("the oldest foreign hold is named and the rest are counted", () => {
  const second = { ...nightlyHold, job_id: "job-second" };
  assert.match(slotBlockage(pool({ slots_total: 2, slots_used: 2, held: [nightlyHold, second] }), ours), /^capture slot held by job e8d1e497-54ae-420e-be02-7ef77059cc82 .*\(\+1 more\)$/);
});

// The call-artifacts proof uses an automatic Recording, so its id is only known once Capture starts.
const apiRun = (response) => ({
  tenantPath: "/v1/tenants/t1",
  apiRequest: async () => {
    if (response instanceof Error) throw response;
    return response;
  },
});

test("call-artifacts preflight fails before the call when another job holds the last slot", async () => {
  await assert.rejects(checkCaptureSlotFree(apiRun(pool({ held: [nightlyHold] }))), (error) => {
    assert.equal(error.reason, "capture-slot-held");
    assert.match(error.message, /^capture slot held by job e8d1e497-54ae-420e-be02-7ef77059cc82 since 2026-11-08T16:25:26.431829Z \(recording 2a6bacc0-04af-53ed-bfcd-a16c310bcfcb, Episode fdea4ab9-/);
    return true;
  });
});

test("call-artifacts preflight passes with a free slot or an unreadable pool", async () => {
  await checkCaptureSlotFree(apiRun(pool({ slots_used: 0 })));
  await checkCaptureSlotFree(apiRun(new Error("HTTP 403")));
});

test("an automatic Recording's own hold is not a blockage once its id is known", async () => {
  let recordingId;
  const nightlyPool = { pool: pool({ held: [nightlyHold] }) };
  const early = run(nightlyPool, { recordingId: () => recordingId });
  recordingId = nightlyHold.recording_id;
  await assert.rejects(early.result, /Capture ready timed out after 180s/);
  const foreign = run(nightlyPool, { recordingId: () => ours });
  await assert.rejects(foreign.result, /capture slot held by job e8d1e497-54ae-420e-be02-7ef77059cc82/);
});
