import type { ChalkRemoteMedia, ChalkSessionSnapshot } from "@q9labsai/chalk-client";

import { useChalkSelector } from "./useChalkSelector";

const selectRemoteMedia = (snapshot: ChalkSessionSnapshot): readonly ChalkRemoteMedia[] => snapshot.remoteMedia;

export function useRemoteMedia(): readonly ChalkRemoteMedia[] {
  return useChalkSelector(selectRemoteMedia);
}
