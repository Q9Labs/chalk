import type { ChalkSessionSnapshot } from "../client-compat";
import { useCallback, useRef, useSyncExternalStore } from "react";

import { useChalkSession } from "../context/chalk-provider";

export type ChalkSelector<T> = (snapshot: ChalkSessionSnapshot) => T;
export type ChalkSelectionEquality<T> = (previous: T, next: T) => boolean;

type SelectionCache<T> = {
  readonly selector: ChalkSelector<T>;
  readonly snapshot: ChalkSessionSnapshot;
  readonly selection: T;
};

export function useChalkSelector<T>(selector: ChalkSelector<T>, isEqual: ChalkSelectionEquality<T> = Object.is): T {
  const session = useChalkSession();
  const cacheRef = useRef<SelectionCache<T> | null>(null);
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const getSelection = useCallback(() => {
    const snapshot = session.getSnapshot();
    const cached = cacheRef.current;

    if (cached !== null && cached.snapshot === snapshot && cached.selector === selector) {
      return cached.selection;
    }

    const selection = selector(snapshot);
    let stableSelection = selection;
    if (cached !== null && isEqual(cached.selection, selection)) {
      stableSelection = cached.selection;
    }
    cacheRef.current = { selector, snapshot, selection: stableSelection };
    return stableSelection;
  }, [isEqual, selector, session]);

  return useSyncExternalStore(subscribe, getSelection, getSelection);
}
