import type { ChalkSessionSnapshot } from "@q9labsai/chalk-client";
import { useEffect, useState } from "react";

export function useConferenceDuration(state: ChalkSessionSnapshot["state"]): number {
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (state !== "live") return;
    const interval = window.setInterval(() => setDuration((value) => value + 1), 1_000);
    return () => window.clearInterval(interval);
  }, [state]);

  return duration;
}
