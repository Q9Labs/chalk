import type { SpaceSnapshot } from "@q9labsai/chalk-client";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { useSpaceClient } from "../context/space-client-context";

/**
 * Reads one value from the call's snapshot and re-renders only when that value changes by
 * `isEqual`, so one person's change re-renders only their own tile. `select` must be stable
 * (wrap it in `useCallback`).
 */
export function useSpaceSelector<T>(select: (snapshot: SpaceSnapshot) => T, isEqual: (a: T, b: T) => boolean = Object.is): T {
  const client = useSpaceClient();
  const cache = useRef<{ readonly snapshot: SpaceSnapshot; readonly select: (snapshot: SpaceSnapshot) => T; readonly value: T } | null>(null);
  const subscribe = useCallback((listener: () => void) => client.subscribe(listener), [client]);
  const getSnapshot = useCallback(() => {
    const snapshot = client.getSnapshot();
    const cached = cache.current;
    if (cached && cached.snapshot === snapshot && cached.select === select) return cached.value;
    const next = select(snapshot);
    const value = cached && cached.select === select && isEqual(cached.value, next) ? cached.value : next;
    cache.current = { snapshot, select, value };
    return value;
  }, [client, isEqual, select]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Equal when both objects hold the same values under the same keys, compared with `Object.is`. */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.is(Reflect.get(a, key), Reflect.get(b, key)));
}
