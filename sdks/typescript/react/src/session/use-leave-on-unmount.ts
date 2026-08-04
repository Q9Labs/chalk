import type { SpaceClientStore } from "../client-compat";
import { useEffect, useRef } from "react";

type DisposableSpaceClientStore = Pick<SpaceClientStore, "leave"> & { readonly dispose?: () => void };

export function useLeaveOnUnmount(session: DisposableSpaceClientStore | null, onUnmount: () => void): void {
  const sessionRef = useRef(session);
  const onUnmountRef = useRef(onUnmount);
  sessionRef.current = session;
  onUnmountRef.current = onUnmount;

  useEffect(
    () => () => {
      onUnmountRef.current();
      const currentSession = sessionRef.current;
      if (currentSession)
        void currentSession
          .leave()
          .catch(() => undefined)
          .finally(() => currentSession.dispose?.());
    },
    [],
  );
}
