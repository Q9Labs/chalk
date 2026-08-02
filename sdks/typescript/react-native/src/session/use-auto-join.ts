import { useEffect, useRef } from "react";

export function useAutoJoin(enabled: boolean, begin: () => Promise<void>): void {
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    void begin().catch(() => undefined);
  }, [begin, enabled]);
}
