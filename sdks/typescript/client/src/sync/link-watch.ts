/**
 * Decides whether a Sync drop is proven short. A drop is long when any of these holds, and nothing else makes it long
 * (a hidden tab, throttled timers and a slow network do not):
 * - the wall clock went backwards;
 * - the wall clock or the monotonic clock advanced `LONG_DROP_MS` or more since the last proof of contact;
 * - the page was frozen, resumed or discarded since then.
 *
 * The proof of contact is the last frame that followed its predecessor within `QUIET_MS`. A frame that arrives after a gap
 * (a woken laptop delivering buffered frames) and the burst right behind it prove nothing, so they cannot make a drop
 * after a long suspend look short. Heartbeats arrive about every 20 s and the network, not a page timer, delivers them,
 * so a gap this long between frames means suspend or loss. No timer runs here.
 *
 * On a quiet call the last frame can be up to 20 s older than the loss, so down time can read up to 20 s too long and the
 * effective cutoff is 40 to 60 s. That errs toward turning the source off.
 */
export const LONG_DROP_MS = 60_000;
const QUIET_MS = 30_000;
const SETTLE_MS = 5_000;

export type LinkReading = { readonly wall: number; readonly mono: number; readonly suspends: number };

export type LinkJudge = {
  /** The last proof of contact, or null before the first frame. */
  readonly proof: () => LinkReading | null;
  /** True unless the time since `proof` is proven short; a missing proof is long. */
  readonly longSince: (proof: LinkReading | null) => boolean;
};

export type LinkClock = { readonly wall: () => number; readonly mono: () => number };

/** The browser document, or any target that fires the Page Lifecycle `freeze` and `resume` events. */
export type PageLifecycle = {
  readonly addEventListener: (type: "freeze" | "resume", listener: () => void) => void;
  readonly removeEventListener: (type: "freeze" | "resume", listener: () => void) => void;
  readonly wasDiscarded?: boolean;
};

const quiet = (from: LinkReading, to: LinkReading): boolean => {
  const wall = to.wall - from.wall;
  return wall >= 0 && wall <= QUIET_MS && to.mono - from.mono <= QUIET_MS && to.suspends === from.suspends;
};

export class LinkWatch implements LinkJudge {
  readonly #clock: LinkClock;
  readonly #page: PageLifecycle | null;
  #suspends = 0;
  #last: LinkReading | null = null;
  #proof: LinkReading | null = null;
  #gap: LinkReading | null = null;
  readonly #suspended = (): void => {
    this.#suspends += 1;
  };

  constructor(clock: LinkClock, page: PageLifecycle | null) {
    this.#clock = clock;
    this.#page = page;
  }

  /** Listens for page suspension. Idempotent, and paired with `close`. */
  open(): void {
    this.close();
    this.#page?.addEventListener("freeze", this.#suspended);
    this.#page?.addEventListener("resume", this.#suspended);
  }

  close(): void {
    this.#page?.removeEventListener("freeze", this.#suspended);
    this.#page?.removeEventListener("resume", this.#suspended);
  }

  /** Call for every frame decoded from Sync, before anything else reads the link. */
  heard(): void {
    const at = this.#read();
    const previous = this.#last;
    this.#last = at;
    if (previous !== null && !quiet(previous, at)) {
      this.#gap = at;
      return;
    }
    if (this.#gap !== null && Math.min(at.wall - this.#gap.wall, at.mono - this.#gap.mono) < SETTLE_MS) return;
    this.#gap = null;
    this.#proof = at;
  }

  proof(): LinkReading | null {
    return this.#proof;
  }

  longSince(proof: LinkReading | null): boolean {
    if (proof === null) return true;
    const now = this.#read();
    const wall = now.wall - proof.wall;
    return wall < 0 || wall >= LONG_DROP_MS || now.mono - proof.mono >= LONG_DROP_MS || now.suspends !== proof.suspends;
  }

  #read(): LinkReading {
    return { wall: this.#clock.wall(), mono: this.#clock.mono(), suspends: this.#suspends + (this.#page?.wasDiscarded === true ? 1 : 0) };
  }
}
