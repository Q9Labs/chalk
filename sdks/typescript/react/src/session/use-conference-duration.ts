import type { SpaceSnapshotView } from "../client-compat";
import { useEffect, useState } from "react";

export function useConferenceDuration(state: SpaceSnapshotView["connectionStatus"]): number {
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (state !== "live") return;
    const interval = window.setInterval(() => setDuration((value) => value + 1), 1_000);
    return () => window.clearInterval(interval);
  }, [state]);

  return duration;
}
