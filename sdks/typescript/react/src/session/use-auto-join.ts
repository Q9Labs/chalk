import { useEffect, useRef } from "react";

export function useAutoJoin(enabled: boolean, join: () => Promise<void>, onError?: (error: Error) => void): void {
  const started = useRef(false);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    void join().catch((cause: unknown) => {
      onError?.(cause instanceof Error ? cause : new Error(String(cause)));
    });
  }, [enabled, join, onError]);
}
