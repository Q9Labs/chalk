import type { SyncClock } from "../sync/types";

const HEARTBEAT_INTERVAL_MS = 4_000;
const SLOW_HEARTBEAT_MS = 2_000;
const MAX_SLOW_HEARTBEATS = 2;
const MAX_TIMER_DRIFT_MS = 250;
const MAX_SLOW_CONNECTION_BACKOFF_MS = 4_000;

export type WhiteboardV1WatchdogReplacement = {
  readonly reason: "slow_heartbeat";
  readonly roundTripsMs: readonly number[];
  readonly outstandingAgesMs: readonly number[];
  readonly backoffMs: number;
};

export type WhiteboardV1WatchdogHost = {
  readonly clock: () => SyncClock & { readonly monotonicNow: () => number };
  readonly enabled: boolean;
  readonly isLive: () => boolean;
  readonly ping: () => void;
  readonly hasConnection: () => boolean;
  /** Drops the slow connection and reconnects without waiting for its closing handshake. */
  readonly replaceConnection: (event: WhiteboardV1WatchdogReplacement) => void;
};

/**
 * Pings a live board connection and replaces it when answers keep coming back slowly. A probe counts only when the
 * timers and the page behaved: a paused tab, a late timer or a connection that just moved data resets the sample.
 */
export class WhiteboardV1Watchdog {
  readonly #host: WhiteboardV1WatchdogHost;
  readonly #heartbeats: { readonly sentAt: number; slow: boolean }[] = [];
  readonly #roundTrips: number[] = [];
  #timer: unknown;
  #ignoredHeartbeats = 0;
  #slowHeartbeats = 0;
  #nextReplacementAt = 0;
  #dueAt = 0;
  #lastProgressAt = Number.NEGATIVE_INFINITY;
  #backoffMs = 0;
  #healthySince: number | null = null;
  #resumedAt = Number.NEGATIVE_INFINITY;

  constructor(host: WhiteboardV1WatchdogHost) {
    this.#host = host;
  }

  /** Starts after a welcome, late enough to honor the backoff the last replacement set. */
  startAfterWelcome(): void {
    this.#start(HEARTBEAT_INTERVAL_MS + Math.max(0, this.#nextReplacementAt - this.#now()));
  }

  stop(): void {
    this.#heartbeats.length = 0;
    this.#ignoredHeartbeats = 0;
    this.#slowHeartbeats = 0;
    this.#roundTrips.length = 0;
    this.#healthySince = null;
    if (this.#timer === undefined) return;
    this.#host.clock().clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** The connection moved data other than a pong, so probes in flight no longer say anything about it. */
  noteProgress(): void {
    this.#lastProgressAt = this.#now();
    this.#reset();
  }

  noteResume(): void {
    this.#resumedAt = this.#now();
    this.#reset();
  }

  receivePong(): void {
    // Sync sends exactly one immediate pong per ping; open WebSockets deliver in FIFO order.
    // A missing pong means a broken/stalled path. Even if one were lost on a working
    // path, an extra reconnect/catch-up is acceptable; never match it to a newer ping.
    const now = this.#now();
    const qualified = this.#qualifyProbe(now);
    if (this.#ignoredHeartbeats > 0) {
      this.#ignoredHeartbeats -= 1;
      return;
    }
    const heartbeat = this.#heartbeats.shift();
    if (!heartbeat) {
      this.#reset();
      return;
    }
    if (!qualified) return;
    const roundTrip = now - heartbeat.sentAt;
    this.#roundTrips.push(roundTrip);
    if (this.#roundTrips.length > MAX_SLOW_HEARTBEATS) this.#roundTrips.shift();
    if (roundTrip < SLOW_HEARTBEAT_MS) {
      this.#slowHeartbeats = 0;
      this.#healthySince ??= now;
      if (now - this.#healthySince >= 60_000) this.#backoffMs = 0;
      this.#host.clock().clearTimeout(this.#timer);
      this.#start(HEARTBEAT_INTERVAL_MS);
    } else {
      this.#healthySince = null;
      if (!heartbeat.slow) this.#slowHeartbeats += 1;
    }
    this.#replaceSlowConnection();
  }

  #start(delay: number): void {
    this.#dueAt = this.#now() + delay;
    this.#timer = this.#host.clock().setTimeout(() => {
      this.#timer = undefined;
      if (!this.#host.isLive()) return;
      const now = this.#now();
      const qualified = this.#qualifyProbe(now);
      if (qualified && this.#checkSlowHeartbeats(now)) return;
      if (qualified) this.#heartbeats.push({ sentAt: now, slow: false });
      else this.#ignoredHeartbeats += 1;
      this.#host.ping();
      const outstanding = this.#heartbeats.length > 0;
      this.#start(this.#host.enabled && outstanding ? SLOW_HEARTBEAT_MS : HEARTBEAT_INTERVAL_MS);
    }, delay);
  }

  #checkSlowHeartbeats(now: number): boolean {
    for (const heartbeat of this.#heartbeats) {
      if (!heartbeat.slow && now - heartbeat.sentAt >= SLOW_HEARTBEAT_MS) {
        heartbeat.slow = true;
        this.#healthySince = null;
        this.#slowHeartbeats += 1;
      }
    }
    return this.#replaceSlowConnection();
  }

  #reset(): void {
    this.#ignoredHeartbeats += this.#heartbeats.length;
    this.#heartbeats.length = 0;
    this.#slowHeartbeats = 0;
    this.#roundTrips.length = 0;
    this.#healthySince = null;
  }

  #qualifyProbe(now: number): boolean {
    if (!this.#host.enabled || globalThis.document?.hidden || now - this.#resumedAt < HEARTBEAT_INTERVAL_MS || now - this.#dueAt > MAX_TIMER_DRIFT_MS || now - this.#lastProgressAt < SLOW_HEARTBEAT_MS) {
      this.#reset();
      return false;
    }
    return true;
  }

  #replaceSlowConnection(): boolean {
    const now = this.#now();
    if (this.#slowHeartbeats < MAX_SLOW_HEARTBEATS || now < this.#nextReplacementAt || !this.#host.hasConnection()) return false;
    this.#backoffMs = Math.min(MAX_SLOW_CONNECTION_BACKOFF_MS, this.#backoffMs === 0 ? 1_000 : this.#backoffMs * 2);
    // Delay the next probe cycle, rather than ignoring failures during a flat cooldown.
    this.#nextReplacementAt = now + this.#backoffMs;
    this.#host.replaceConnection({
      reason: "slow_heartbeat",
      roundTripsMs: [...this.#roundTrips],
      outstandingAgesMs: this.#heartbeats.slice(-2).map((heartbeat) => now - heartbeat.sentAt),
      backoffMs: this.#backoffMs,
    });
    return true;
  }

  #now(): number {
    // Wall-clock timestamps stay on the client's clock.now() for persisted operation ordering.
    return this.#host.clock().monotonicNow();
  }
}
