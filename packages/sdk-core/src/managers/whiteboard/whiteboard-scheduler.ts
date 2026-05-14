export class WhiteboardDebouncedScheduler {
  private timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly debounceMs: number) {}

  schedule(task: () => void): void {
    this.cancel();
    this.timeout = setTimeout(() => {
      this.timeout = null;
      task();
    }, this.debounceMs);
  }

  cancel(): void {
    if (!this.timeout) {
      return;
    }

    clearTimeout(this.timeout);
    this.timeout = null;
  }
}
