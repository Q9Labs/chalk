import { useSyncExternalStore } from "react";

/** Server render and environments without `matchMedia` get `false`. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (change) => {
      const list = globalThis.matchMedia?.(query);
      list?.addEventListener("change", change);
      return () => list?.removeEventListener("change", change);
    },
    () => globalThis.matchMedia?.(query).matches ?? false,
    () => false,
  );
}
