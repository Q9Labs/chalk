import { callCountdown, callLimitMessage } from "@q9labsai/chalk-client";
import { useEffect } from "react";
import { useConnection } from "../hooks/space-hooks";
import { useToasts } from "../primitives/toast/ToastStack";

/**
 * Tells the person when the call is 10, 5 and 1 minutes from its time limit. The deadline follows
 * extensions, so an extended call warns again at its new limit.
 */
export function useCallLimitWarning(): void {
  const deadline = useConnection().episode?.deadline;
  const toasts = useToasts();
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [timer] Check the call limit each second and say each threshold once; clear the interval when the deadline changes.
  useEffect(() => {
    if (!deadline) return;
    let previous: number | null = null;
    const tick = () => {
      const { seconds, warning } = callCountdown(deadline, Date.now(), previous);
      previous = seconds;
      if (warning !== null) toasts.show({ kind: "info", message: callLimitMessage(warning), dismissible: true, testID: "call.limit-warning" });
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [deadline, toasts]);
}
