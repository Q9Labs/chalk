import type { ChalkParticipant, ChalkSessionSnapshot } from "@q9labsai/chalk-client";

import { useChalkSelector } from "./useChalkSelector";

const selectParticipants = (snapshot: ChalkSessionSnapshot): readonly ChalkParticipant[] => snapshot.participants;

export function useParticipants(): readonly ChalkParticipant[] {
  return useChalkSelector(selectParticipants);
}
