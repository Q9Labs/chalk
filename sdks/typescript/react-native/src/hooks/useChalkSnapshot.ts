import type { ChalkSessionSnapshot } from "../client-compat";

import { useChalkSelector } from "./useChalkSelector";

const selectSnapshot = (snapshot: ChalkSessionSnapshot): ChalkSessionSnapshot => snapshot;

export function useChalkSnapshot(): ChalkSessionSnapshot {
  return useChalkSelector(selectSnapshot);
}
