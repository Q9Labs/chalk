import { useEffect, useState } from "react";

/** True once `value` has stayed true for `milliseconds`; false again the moment it turns false. */
export function useTrueFor(value: boolean, milliseconds: number): boolean {
  const [elapsed, setElapsed] = useState(false);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [timer] Delay a notice for this value and duration; reset and cancel the timeout on replacement.
  useEffect(() => {
    setElapsed(false);
    if (!value) return;
    const timer = setTimeout(() => setElapsed(true), milliseconds);
    return () => clearTimeout(timer);
  }, [milliseconds, value]);
  return value && elapsed;
}

/** Whole seconds since `since`, counted by the page's own clock, or 0 while `since` is null. */
export function useElapsedSeconds(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [timer] Tick once a second while a count is running; clear the interval when it stops.
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}
