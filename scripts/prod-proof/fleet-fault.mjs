// One fault pulse at a time for the whole fleet. Every call on the machine shares the media path, so a
// pulse stops every running call at once: calls park at checkpoints, the path is blocked, each call proves its
// media stalled, the path is restored, and each call measures its own recovery from the same instant.
//
// A call that checks in while no pulse is pending continues at once. While a pulse is pending, new calls wait
// in `enter`, so no join is measured across a fault.
export class FaultPulse {
  #running = new Set();
  #parked = new Set();
  #waiters = [];
  #pending = false;
  #phase = "idle";
  #restoredAt = 0;
  #stallChecked = 0;
  #listeners = [];

  constructor({ down, up, holdMs, now = () => performance.now(), sleep = (ms) => new Promise((done) => setTimeout(done, ms)) }) {
    this.down = down;
    this.up = up;
    this.holdMs = holdMs;
    this.now = now;
    this.sleep = sleep;
  }

  #wake() {
    const release = this.#waiters.splice(0);
    for (const resolve of release) resolve();
  }

  #changed() {
    for (const resolve of this.#listeners.splice(0)) resolve();
  }

  async #until(condition) {
    while (!condition()) await new Promise((resolve) => this.#listeners.push(resolve));
  }

  /** A call asks to start. Resolves when no pulse is pending. */
  async enter(call) {
    await this.#until(() => !this.#pending);
    this.#running.add(call);
  }

  leave(call) {
    this.#running.delete(call);
    this.#parked.delete(call);
    this.#changed();
  }

  /**
   * Resolves at once, or after a whole pulse when one is pending. After a pulse it resolves with a `fault`
   * (`stalled`: run the stall proof once the path is down; `restoredAt`: the instant the path came back).
   */
  async checkpoint(call, proveStall) {
    if (!this.#pending) return undefined;
    this.#parked.add(call);
    this.#changed();
    await new Promise((resolve) => this.#waiters.push(resolve));
    // Released with the path down: prove the stall, then wait for the restore.
    let stalled;
    try {
      stalled = await proveStall();
    } finally {
      this.#stallChecked++;
      this.#changed();
    }
    await new Promise((resolve) => this.#waiters.push(resolve));
    this.#parked.delete(call);
    return { stalled, restoredAt: this.#restoredAt };
  }

  /** Runs one pulse. Resolves with the instants the path went down and came back. */
  async run() {
    this.#pending = true;
    try {
      await this.#until(() => this.#parked.size === this.#running.size);
      const calls = this.#running.size;
      this.#phase = "down";
      await this.down();
      this.#stallChecked = 0;
      this.#wake();
      const downAt = this.now();
      await this.sleep(this.holdMs);
      await this.#until(() => this.#stallChecked >= calls);
      this.#restoredAt = this.now();
      try {
        await this.up();
      } finally {
        this.#phase = "idle";
        this.#pending = false;
        this.#wake();
        this.#changed();
      }
      return { calls, downAt, restoredAt: this.#restoredAt };
    } catch (error) {
      this.#pending = false;
      this.#wake();
      this.#changed();
      throw error;
    }
  }

  get pending() {
    return this.#pending;
  }
}
