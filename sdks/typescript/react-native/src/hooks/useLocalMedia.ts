import type { ChalkLocalMedia, ChalkMediaSource, ChalkSessionSnapshot } from "@q9labsai/chalk-client";

import { useChalkSelector } from "./useChalkSelector";

const selectLocalMedia = (snapshot: ChalkSessionSnapshot): Readonly<Record<ChalkMediaSource, ChalkLocalMedia>> => snapshot.localMedia;

export function useLocalMedia(): Readonly<Record<ChalkMediaSource, ChalkLocalMedia>> {
  return useChalkSelector(selectLocalMedia);
}
