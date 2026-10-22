import type { SyncClock } from "./types";

// Leave room for a retry inside the default 10-second join/recovery budget.
// Sync upgrades before authentication; hello and recovery run after open.
export const SYNC_DIAL_TIMEOUT_MS = 3_000;

export function scheduleSyncDialDeadline(clock: Pick<SyncClock, "setTimeout" | "clearTimeout">, onTimeout: () => void): () => void {
  const timer = clock.setTimeout(onTimeout, SYNC_DIAL_TIMEOUT_MS);
  return () => clock.clearTimeout(timer);
}
