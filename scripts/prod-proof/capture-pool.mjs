import { setTimeout as delay } from "node:timers/promises";
import { ProofError } from "./runtime.mjs";

/** Reads the Tenant's view of the Capture pool without ever failing the proof. */
export async function readCapturePool(run) {
  try {
    return { pool: await run.apiRequest("GET", `${run.tenantPath}/recording-capture-pool`) };
  } catch (error) {
    return { unavailable: error.message };
  }
}

/** Says why no slot is free for this proof's Recording, or returns nothing when one is or may become free. */
export function slotBlockage(pool, recordingId) {
  if (pool.slots_total === 0 || pool.slots_used < pool.slots_total) return;
  if (pool.held.some((slot) => slot.recording_id === recordingId)) return;
  const [oldest] = pool.held;
  if (!oldest) return `capture pool full: ${pool.slots_used} of ${pool.slots_total} slots held by other Tenants' jobs`;
  const more = pool.held.length > 1 ? ` (+${pool.held.length - 1} more)` : "";
  return `capture slot held by job ${oldest.job_id} since ${oldest.claimed_at} (recording ${oldest.recording_id}, Episode ${oldest.episode_id}, lease expires ${oldest.lease_expires_at})${more}`;
}

/** Fails before a call starts when another job already holds the last free slot. */
export async function checkCaptureSlotFree(run) {
  const { pool } = await readCapturePool(run);
  const reason = pool && slotBlockage(pool);
  if (reason) throw new ProofError("capture-slot-held", reason);
}

function describeCapturePool(outcome) {
  if (outcome.unavailable) return `capture pool readout unavailable: ${outcome.unavailable}`;
  const { pool } = outcome;
  return `capture pool: ${pool.slots_used} of ${pool.slots_total} slots in use`;
}

const clock = { now: Date.now, sleep: (ms, signal) => delay(ms, undefined, { signal }) };

/**
 * Waits for `ready()`. Without progress, reads the Capture pool after
 * `checkAfterMs` and again at the timeout, and fails at once when another job
 * holds the last free slot. `recordingId` may be a function when the Recording
 * is only known once Capture starts (automatic Recording policy).
 */
export async function waitForCapture({ recordingId, ready, readPool, signal, timeoutMs = 180_000, checkAfterMs = 25_000, intervalMs = 3000, time = clock }) {
  const started = time.now();
  let checked = false;
  const blockage = async () => {
    const outcome = await readPool();
    const own = typeof recordingId === "function" ? recordingId() : recordingId;
    return { outcome, reason: outcome.pool && slotBlockage(outcome.pool, own) };
  };
  while (time.now() - started < timeoutMs) {
    signal?.throwIfAborted();
    if (await ready()) return;
    if (!checked && time.now() - started >= checkAfterMs) {
      checked = true;
      const { reason } = await blockage();
      if (reason) throw new ProofError("capture-slot-held", reason);
    }
    await time.sleep(intervalMs, signal);
  }
  const { outcome, reason } = await blockage();
  if (reason) throw new ProofError("capture-slot-held", reason);
  throw new ProofError("timeout", `Capture ready timed out after ${timeoutMs / 1000}s; ${describeCapturePool(outcome)}`);
}
