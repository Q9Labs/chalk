import { useEffect, useRef, useState } from "react";
import { callCountdown, type CallLimitWarning } from "@q9labsai/chalk-client";

export function useCallCountdown(deadline: string | null | undefined) {
  const [now, setNow] = useState(Date.now);
  const previousCountdown = useRef<{ deadline: typeof deadline; seconds: number | null } | null>(null);
  const [limitWarning, setLimitWarning] = useState<{ id: string; minutes: CallLimitWarning } | null>(null);
  const countdown = callCountdown(deadline, now);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [timer] Refresh the call-limit clock each second; clear the interval when the deadline changes.
  useEffect(() => {
    if (!deadline) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [deadline]);
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [transition] Emit warnings only when the committed countdown crosses a threshold; preserve a dismissed warning between ticks.
  useEffect(() => {
    const previous = previousCountdown.current;
    const next = callCountdown(deadline, now, previous?.deadline === deadline ? previous?.seconds : undefined);
    previousCountdown.current = { deadline, seconds: next.seconds };
    if (previous?.deadline !== deadline) setLimitWarning(null);
    if (next.warning !== null) setLimitWarning({ id: `time-limit-${deadline}-${next.warning}`, minutes: next.warning });
  }, [deadline, now]);
  return { countdown, limitWarning, dismissLimitWarning: () => setLimitWarning(null) };
}
