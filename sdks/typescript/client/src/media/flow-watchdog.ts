type Progress = { value: number; changedAt: number; flowing: boolean };

/** Each source has its own progress window; a healthy direction cannot hide a stalled one. */
export class MediaFlowWatchdog {
  readonly #progress = new Map<string, Progress>();

  observe(key: string, value: number, now: number): boolean {
    const previous = this.#progress.get(key);
    if (!previous || value !== previous.value) {
      this.#progress.set(key, { value, changedAt: now, flowing: value > 0 });
      return false;
    }
    return now - previous.changedAt >= (previous.flowing ? 3_000 : 10_000);
  }

  retain(keys: ReadonlySet<string>): void {
    for (const key of this.#progress.keys()) if (!keys.has(key)) this.#progress.delete(key);
  }

  clear(): void {
    this.#progress.clear();
  }
}
