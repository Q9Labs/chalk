import type { SyncClock } from "./types";

// Sync upgrades before authentication; hello and recovery run after open.
export const SYNC_DIAL_TIMEOUT_MS = 10_000;

export function scheduleSyncDialDeadline(clock: Pick<SyncClock, "setTimeout" | "clearTimeout">, onTimeout: () => void, timeoutMs = SYNC_DIAL_TIMEOUT_MS): () => void {
  const allowance = Number.isFinite(timeoutMs) ? Math.min(60_000, Math.max(SYNC_DIAL_TIMEOUT_MS, timeoutMs)) : SYNC_DIAL_TIMEOUT_MS;
  const timer = clock.setTimeout(onTimeout, allowance);
  return () => clock.clearTimeout(timer);
}
