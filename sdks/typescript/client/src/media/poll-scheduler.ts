// The polling loop: the one timer that drives remote-publication refreshes, and the
// cadence it follows. A successful poll waits out the idle interval; an incomplete one
// or a failed one comes back on a bounded backoff, and a Sync off gets a short repoll
// ladder so a frozen tile drops quickly. The refresh itself belongs to the coordinator
// and runs through #ops.run.
import { POLL_FAILURE_LIMIT, pollFailureDelayMs, remotePullBackoffMs, SYNC_OFF_REPOLL_MS } from "./sfu-limits";

/** What the scheduler needs from the coordinator. */
export interface PollSchedulerOps {
  readonly intervalMs: () => number;
  /** Polling is allowed once media started (or is joining) and not stopped. */
  readonly canPoll: () => boolean;
  /** A hidden tab skips routine polls; a tile change still wakes them. */
  readonly hidden: () => boolean;
  readonly run: () => Promise<void>;
  /** Pulls are still owed, so the next poll comes back on the backoff instead of the idle cadence. */
  readonly pullIncomplete: () => boolean;
  /** A held remote track is off at Sync but still in the roster, so the listing needs a quick re-read. */
  readonly heldTrackOff: () => boolean;
}

export class PollScheduler {
  readonly #ops: PollSchedulerOps;
  #timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  #running = false;
  #afterCurrent = false;
  #failures = 0;
  #failedPull = false;
  #repolls = 0;
  // A tile change must reach the provider even while the tab is hidden, where routine polls pause.
  #tilesChanged = false;

  constructor(ops: PollSchedulerOps) {
    this.#ops = ops;
  }

  get running(): boolean {
    return this.#running;
  }
  canPoll(): boolean {
    return this.#ops.canPoll();
  }
  markTilesChanged(): void {
    this.#tilesChanged = true;
  }
  noteFailedPull(): void {
    this.#failedPull = true;
  }
  /** A refresh that owed nothing clears the failure count. */
  noteSucceeded(): void {
    this.#failures = 0;
  }
  /** A refresh started; a duplicate request while one runs only queues a follow-up. */
  tryBeginRefresh(): boolean {
    if (!this.#ops.canPoll() || this.#running) return false;
    this.#running = true;
    this.#failedPull = false;
    return true;
  }
  /** The refresh ended; a wake requested during it runs now. */
  finishRefresh(): void {
    this.#running = false;
    if (!this.#afterCurrent) return;
    this.#afterCurrent = false;
    this.clear();
    this.wake(0);
  }
  /** New input arrived: repoll at once unless a refresh is in flight, and count the repolls fresh. */
  repoll(): void {
    this.#repolls = 0;
    if (this.#running) {
      this.#afterCurrent = true;
      return;
    }
    this.clear();
    this.wake(0);
  }
  wake(delayMs = this.#ops.intervalMs()): void {
    if (!this.#ops.canPoll() || this.#timer !== undefined) return;
    this.#timer = globalThis.setTimeout(() => void this.#tick(), delayMs);
  }
  async #tick(): Promise<void> {
    this.#timer = undefined;
    // Skip the network round-trip while the tab is hidden; the poll
    // reschedules itself and resumes on the next tick after visibility.
    if (this.#ops.hidden() && !this.#tilesChanged) {
      this.wake();
      return;
    }
    const tilesChanged = this.#tilesChanged;
    this.#tilesChanged = false;
    let nextDelay = this.#ops.intervalMs();
    try {
      await this.#ops.run();
      nextDelay = this.#nextDelay();
    } catch {
      // A hidden tab polls only after a tile change, so a failed refresh keeps that change for the retry.
      if (tilesChanged) this.#tilesChanged = true;
      nextDelay = this.#failedPull && this.#ops.pullIncomplete() ? this.#incompleteDelay() : this.#failureDelay();
    } finally {
      this.wake(nextDelay);
    }
  }
  #nextDelay(): number {
    if (this.#ops.pullIncomplete()) return this.#incompleteDelay();
    const repoll = SYNC_OFF_REPOLL_MS[this.#repolls];
    if (repoll === undefined || !this.#ops.heldTrackOff()) return this.#ops.intervalMs();
    this.#repolls++;
    return repoll;
  }
  #incompleteDelay(): number {
    this.#failures = Math.min(this.#failures + 1, POLL_FAILURE_LIMIT);
    return remotePullBackoffMs(this.#failures, this.#ops.intervalMs());
  }
  // Keep the first retry prompt, then return toward the idle polling cadence.
  #failureDelay(): number {
    this.#failures = Math.min(this.#failures + 1, POLL_FAILURE_LIMIT);
    return pollFailureDelayMs(this.#failures, this.#ops.intervalMs());
  }
  clear(): void {
    this.#failures = 0;
    if (this.#timer !== undefined) globalThis.clearTimeout(this.#timer);
    this.#timer = undefined;
  }
  /** A dead negotiation cancels the refresh without losing a queued wake. */
  interrupt(): void {
    this.clear();
    this.#running = false;
  }
  reset(): void {
    this.#running = false;
    this.#afterCurrent = false;
    this.clear();
  }
}
