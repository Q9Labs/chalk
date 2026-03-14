import type { Participant, ParticipantState } from "@q9labs/chalk-core";
import { useEffect, useMemo, useState } from "react";
import { useSession } from "../context/chalk-native-provider";

export interface UseParticipantsReturn {
  participants: readonly Participant[];
  localParticipant: Participant | null;
  remoteParticipants: readonly Participant[];
  activeSpeaker: Participant | null;
  participantCount: number;
  getParticipant: (id: string) => Participant | undefined;
  updateDisplayName: (name: string) => Promise<void>;
}

export function useParticipants(): UseParticipantsReturn {
  const session = useSession();
  const { participants: manager } = session;
  const [state, setState] = useState<ParticipantState>(() => manager.getState());

  useEffect(() => manager.subscribe(setState), [manager]);

  const getParticipant = useMemo(() => (id: string) => manager.getParticipant(id), [manager]);
  const updateDisplayName = useMemo(() => (name: string) => session.updateOwnDisplayName(name), [session]);

  return useMemo(
    () => ({
      participants: state.participants,
      localParticipant: state.localParticipant,
      remoteParticipants: manager.remoteParticipants,
      activeSpeaker: state.activeSpeaker,
      participantCount: state.count,
      getParticipant,
      updateDisplayName,
    }),
    [state, manager, getParticipant, updateDisplayName],
  );
}
