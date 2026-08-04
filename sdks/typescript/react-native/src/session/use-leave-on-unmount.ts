import type { ChalkSessionStore } from "../client-compat";
import { useEffect, useRef } from "react";

type DisposableStore = Pick<ChalkSessionStore, "leave"> & { readonly dispose?: () => void };

export async function leaveAndDispose(store: DisposableStore): Promise<void> {
  try {
    await store.leave();
  } catch {
    // Cleanup is best effort while React Native unmounts.
  } finally {
    try {
      store.dispose?.();
    } catch {
      // Cleanup is best effort while React Native unmounts.
    }
  }
}

export function useLeaveOnUnmount(store: DisposableStore | null, onUnmount: () => void): void {
  const storeRef = useRef(store);
  const onUnmountRef = useRef(onUnmount);
  storeRef.current = store;
  onUnmountRef.current = onUnmount;

  useEffect(
    () => () => {
      onUnmountRef.current();
      const currentStore = storeRef.current;
      if (currentStore) void leaveAndDispose(currentStore);
    },
    [],
  );
}
