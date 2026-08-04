import type { ChalkRemoteMedia, ChalkSessionSnapshot } from "../client-compat";

import { useChalkSelector } from "./useChalkSelector";

const selectRemoteMedia = (snapshot: ChalkSessionSnapshot): readonly ChalkRemoteMedia[] => snapshot.remoteMedia;

export function useRemoteMedia(): readonly ChalkRemoteMedia[] {
  return useChalkSelector(selectRemoteMedia);
}
