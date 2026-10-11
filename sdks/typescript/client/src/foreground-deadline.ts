type DeadlineClock = {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, milliseconds: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
};

/** A suspended browser cannot provide evidence that a foreground operation timed out. */
export function scheduleForegroundDeadline(clock: DeadlineClock, milliseconds: number, expired: () => void): () => void {
  let timer: unknown;
  let cancelled = false;
  const arm = () => {
    const started = clock.now();
    timer = clock.setTimeout(() => {
      if (cancelled) return;
      const elapsed = clock.now() - started;
      if ((typeof document !== "undefined" && document.visibilityState === "hidden") || elapsed > milliseconds + 2_000 || elapsed < 0) arm();
      else expired();
    }, milliseconds);
  };
  arm();
  return () => {
    cancelled = true;
    clock.clearTimeout(timer);
  };
}
