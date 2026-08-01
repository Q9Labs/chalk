import type { ChalkSessionStore } from "@q9labsai/chalk-client";
import { useEffect, useRef } from "react";

export function useLeaveOnUnmount(session: Pick<ChalkSessionStore, "leave"> | null, onUnmount: () => void): void {
  const sessionRef = useRef(session);
  const onUnmountRef = useRef(onUnmount);
  sessionRef.current = session;
  onUnmountRef.current = onUnmount;

  useEffect(
    () => () => {
      onUnmountRef.current();
      void sessionRef.current?.leave().catch(() => undefined);
    },
    [],
  );
}
