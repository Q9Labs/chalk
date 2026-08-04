import type { ChalkParticipant, ChalkSessionSnapshot } from "../client-compat";

import { useChalkSelector } from "./useChalkSelector";

const selectParticipants = (snapshot: ChalkSessionSnapshot): readonly ChalkParticipant[] => snapshot.participants;

export function useParticipants(): readonly ChalkParticipant[] {
  return useChalkSelector(selectParticipants);
}
