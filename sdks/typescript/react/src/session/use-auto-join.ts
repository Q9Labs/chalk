import { useEffect, useRef } from "react";

export function useAutoJoin(join: () => Promise<void>): void {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void join().catch(() => undefined);
  }, [join]);
}
