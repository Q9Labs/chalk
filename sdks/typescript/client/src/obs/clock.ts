import { CLOCK, type ClockState } from "./registry.ts";

export type ClockStamp = {
  readonly client_mono_ms: number;
  readonly client_wall_ms: number;
  readonly clock_state: ClockState;
  readonly clock_epoch: number;
  readonly est_server_ms?: number;
  readonly clock_err_ms?: number;
};

type Sample = { readonly receivedMono: number; readonly serverAtReceive: number; readonly halfRtt: number };

const MAX_SAMPLES = 8;

// Estimates server time from request round trips. Each sample bounds the error by half its round trip, and the
// bound grows with the sample's age by the registry's drift rate. A wall-clock step against the monotonic clock
// drops every sample and starts a new epoch, because records on either side of the step can't be compared by time.
export class ClockEstimator {
  readonly #mono: () => number;
  readonly #wall: () => number;
  #samples: Sample[] = [];
  #epoch = 0;
  #wallMinusMono: number;

  constructor(clocks: { readonly mono: () => number; readonly wall: () => number }) {
    this.#mono = clocks.mono;
    this.#wall = clocks.wall;
    this.#wallMinusMono = this.#wall() - this.#mono();
  }

  // One round trip: when the request left, when the answer came back (both monotonic) and the server's time in it.
  sample(sentMono: number, receivedMono: number, serverMs: number): void {
    const rtt = receivedMono - sentMono;
    if (!(rtt >= 0) || !Number.isFinite(serverMs)) return;
    this.#samples = [...this.#samples, { receivedMono, serverAtReceive: serverMs + rtt / 2, halfRtt: rtt / 2 }].slice(-MAX_SAMPLES);
  }

  // Returns how far the wall clock stepped when it moved by more than the registry's jump threshold, and resets.
  detectJump(): number | undefined {
    const now = this.#wall() - this.#mono();
    const jump = now - this.#wallMinusMono;
    if (Math.abs(jump) <= CLOCK.jumpMs) return undefined;
    this.#wallMinusMono = now;
    this.#samples = [];
    this.#epoch += 1;
    return Math.round(jump);
  }

  stamp(): ClockStamp {
    const mono = this.#mono();
    const base = { client_mono_ms: mono, client_wall_ms: Math.round(this.#wall()), clock_epoch: this.#epoch };
    let best: { readonly estimate: number; readonly error: number } | undefined;
    for (const sample of this.#samples) {
      const age = Math.max(0, mono - sample.receivedMono);
      const error = sample.halfRtt + (age * CLOCK.driftPpm) / 1_000_000;
      if (!best || error < best.error) best = { estimate: sample.serverAtReceive + age, error };
    }
    if (!best) return { ...base, clock_state: "unsynced" };
    return { ...base, clock_state: "synced", est_server_ms: Math.round(best.estimate), clock_err_ms: Math.ceil(best.error) };
  }
}
