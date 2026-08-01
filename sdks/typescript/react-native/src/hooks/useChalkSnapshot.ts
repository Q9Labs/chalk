import type { ChalkSessionSnapshot } from "@q9labsai/chalk-client";

import { useChalkSelector } from "./useChalkSelector";

const selectSnapshot = (snapshot: ChalkSessionSnapshot): ChalkSessionSnapshot => snapshot;

export function useChalkSnapshot(): ChalkSessionSnapshot {
  return useChalkSelector(selectSnapshot);
}
