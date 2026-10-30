/** Measure completed effect frames using wall time, including processing cost. */
export class CameraEffectPerformance {
  #warmUntil: number | undefined;
  #started: number | undefined;
  #frames = 0;

  reset(): void {
    this.#warmUntil = undefined;
    this.#started = undefined;
    this.#frames = 0;
  }

  record(now: number): boolean {
    this.#warmUntil ??= now + 1000;
    if (now < this.#warmUntil) return false;
    this.#started ??= now;
    this.#frames++;
    const elapsed = now - this.#started;
    if (elapsed < 3000) return false;
    const slow = (this.#frames * 1000) / elapsed < 15;
    this.#started = now;
    this.#frames = 0;
    return slow;
  }
}
