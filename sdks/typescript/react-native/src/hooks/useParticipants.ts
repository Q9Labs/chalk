import type { ParticipantState } from "../internal/core";
import { useMemo } from "react";
import { useSession } from "../context/chalk-native-provider";
import { useManagerState } from "./external-store";

type RoomParticipant = ParticipantState["participants"][number];

export interface UseParticipantsReturn {
  participants: readonly RoomParticipant[];
  localParticipant: RoomParticipant | null;
  remoteParticipants: readonly RoomParticipant[];
  activeSpeaker: RoomParticipant | null;
  participantCount: number;
  getParticipant: (id: string) => RoomParticipant | undefined;
  updateDisplayName: (name: string) => Promise<void>;
}

export function useParticipants(): UseParticipantsReturn {
  const session = useSession();
  const { participants: manager } = session;
  const state = useManagerState<ParticipantState>(manager);

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
