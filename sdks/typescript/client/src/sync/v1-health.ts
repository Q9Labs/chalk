/** Presentation health, independent of transport reconnection and its 60-second watchdog. */
export type SyncHealth = "healthy" | "degraded" | "recovering";

// One-in-four replies to 500 ms probes arrive every 2 s. Eight silent probe intervals
// distinguish that lossy-but-open path from an outage; one reply cannot clear an outage.
export const SYNC_HEALTH_BUDGET = {
  probeIntervalMs: 500,
  degradedAfterMs: 750,
  recoveringAfterMs: 4000,
  stablePongsForMs: 2000,
} as const;

export class V1SyncHealth {
  health: SyncHealth = "healthy";
  #lastPongAt: number;
  #stableSince: number | null = null;

  constructor(now: number) {
    this.#lastPongAt = now;
  }

  observePong(now: number): void {
    this.check(now);
    const gap = now - this.#lastPongAt;
    this.#lastPongAt = now;
    if (this.health === "healthy") return;
    if (gap > SYNC_HEALTH_BUDGET.degradedAfterMs || this.#stableSince === null) this.#stableSince = now;
    if (now - this.#stableSince >= SYNC_HEALTH_BUDGET.stablePongsForMs) {
      this.health = "healthy";
      this.#stableSince = null;
    }
  }

  check(now: number): void {
    const silence = now - this.#lastPongAt;
    if (silence >= SYNC_HEALTH_BUDGET.degradedAfterMs) this.#stableSince = null;
    if (silence >= SYNC_HEALTH_BUDGET.recoveringAfterMs) this.health = "recovering";
    else if (silence >= SYNC_HEALTH_BUDGET.degradedAfterMs && this.health === "healthy") this.health = "degraded";
  }
}
