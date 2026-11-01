/**
 * Decides whether a Sync drop is proven short. Contact is proven only by a ping and the pong that answers it: the pong proves
 * contact at the moment the ping was SENT, and only when the round trip took 0 to `ROUND_TRIP_MS` on both the wall clock and the
 * monotonic clock, with no page freeze, resume or discard in between. A pong that was buffered through a suspend shows a long round
 * trip, a clock step back shows a negative one, and neither proves anything. No other frame proves contact, because a frame says
 * when the page processed it, not when Sync sent it.
 *
 * A pong answers the oldest ping in flight, so pairing is only sound while every ping is answered in time and none is dropped. A
 * ping that stays unanswered past `ROUND_TRIP_MS`, a pong that arrives that late, or more than `PINGS_IN_FLIGHT` pings in flight
 * stalls the socket: from then on no pong on it proves contact, because a pong could pair with a younger ping than the one it
 * answers. The stall lasts until `restart()`, which the client calls on the next socket. `V1SyncClient` replaces a stalled
 * socket through its normal reconnect, so proof pauses while the socket is being replaced and resumes on the new one.
 *
 * A drop is long when any of these holds, and nothing else makes it long (a hidden tab, throttled timers and a slow network do not):
 * - no contact was ever proven;
 * - either clock went backwards since the last proven contact;
 * - either clock advanced `LONG_DROP_MS` or more since the last proven contact;
 * - the page was frozen, resumed or discarded since then.
 *
 * Known gap: a tab hidden for over 5 minutes with no live WebRTC connection runs its timers once a minute, so it sends one ping a
 * minute and its last proof can be nearly 60 s old when the link drops. A short drop then reads long and the source turns off.
 * That errs toward off, and Chrome exempts a page that holds a live WebRTC connection.
 *
 * On a quiet call the last ping can be up to 20 s older than the loss, so down time can read up to 20 s too long and the
 * effective cutoff is 40 to 60 s. That errs toward turning the source off.
 */
export const LONG_DROP_MS = 60_000;
const ROUND_TRIP_MS = 5_000;
// Pings sent and not answered yet. A connection answers in order, so a pong belongs to the oldest one. At one probe every
// 500 ms and a 5 s limit, a healthy socket holds about 10; more than this means a stall.
const PINGS_IN_FLIGHT = 16;

export type LinkReading = { readonly wall: number; readonly mono: number; readonly suspends: number };

export type LinkJudge = {
  /** The last proof of contact, or null before the first answered ping. */
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

export class LinkWatch implements LinkJudge {
  readonly #clock: LinkClock;
  readonly #page: PageLifecycle | null;
  #suspends = 0;
  #pings: LinkReading[] = [];
  #proof: LinkReading | null = null;
  #stalled = false;
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

  /** True once a ping went unanswered in time on this socket; no pong proves contact until `restart()`. */
  get stalled(): boolean {
    return this.#stalled;
  }

  /** Call when a connection goes live: the previous socket's pings will not be answered, and a stall ends with it. */
  restart(): void {
    this.#pings = [];
    this.#stalled = false;
  }

  /** Call as a ping goes out, in the same order as the pings. */
  pinged(): void {
    if (this.#stalled) return;
    const now = this.#read();
    const oldest = this.#pings[0];
    if (oldest !== undefined && (!this.#inTime(oldest, now) || this.#pings.length >= PINGS_IN_FLIGHT)) {
      this.#stall();
      return;
    }
    this.#pings.push(now);
  }

  /** Call as a pong is received. It answers the oldest ping in flight. */
  ponged(): void {
    if (this.#stalled) return;
    const sent = this.#pings.shift();
    if (sent === undefined) return;
    if (!this.#inTime(sent, this.#read())) {
      this.#stall();
      return;
    }
    this.#proof = sent;
  }

  proof(): LinkReading | null {
    return this.#proof;
  }

  longSince(proof: LinkReading | null): boolean {
    if (proof === null) return true;
    const now = this.#read();
    const wall = now.wall - proof.wall;
    const mono = now.mono - proof.mono;
    return wall < 0 || mono < 0 || wall >= LONG_DROP_MS || mono >= LONG_DROP_MS || now.suspends !== proof.suspends;
  }

  #stall(): void {
    this.#stalled = true;
    this.#pings = [];
  }

  // A ping counts as answered in time when it took 0 to `ROUND_TRIP_MS` on both clocks with no page freeze or resume between.
  #inTime(sent: LinkReading, now: LinkReading): boolean {
    const wall = now.wall - sent.wall;
    const mono = now.mono - sent.mono;
    return wall >= 0 && wall <= ROUND_TRIP_MS && mono >= 0 && mono <= ROUND_TRIP_MS && now.suspends === sent.suspends;
  }

  #read(): LinkReading {
    return { wall: this.#clock.wall(), mono: this.#clock.mono(), suspends: this.#suspends + (this.#page?.wasDiscarded === true ? 1 : 0) };
  }
}
