import { useCallback, useMemo } from "react";

import { useChalkSession } from "../context/chalk-native-provider";
import type { NativeParticipant, NativeParticipantState } from "../ui/native-types";
import { useChalkSnapshot } from "./useChalkRoomActions";

export interface UseParticipantsReturn extends NativeParticipantState {
  readonly remoteParticipants: readonly NativeParticipant[];
  readonly participantCount: number;
  readonly getParticipant: (participantSessionId: string) => NativeParticipant | undefined;
  readonly updateDisplayName: (displayName: string) => Promise<void>;
}

export function useParticipants(): UseParticipantsReturn {
  const session = useChalkSession();
  const snapshot = useChalkSnapshot();
  const localParticipantId = snapshot.subject?.participantSessionId ?? null;
  const participants = useMemo(
    () =>
      snapshot.participants.map((participant): NativeParticipant => {
        const participantMedia = snapshot.participantMedia[participant.participantSessionId];
        const remoteMedia = snapshot.remoteMedia.filter((publication) => publication.participantSessionId === participant.participantSessionId);
        const local = participant.participantSessionId === localParticipantId;
        const localMedia = local ? snapshot.localMedia : null;
        return {
          ...participant,
          id: participant.participantSessionId,
          audioEnabled: local ? localMedia?.microphone.state === "enabled" : participantMedia?.microphone === "active",
          videoEnabled: local ? localMedia?.camera.state === "enabled" : participantMedia?.camera === "active",
          audioTrack: local ? (localMedia?.microphone.track ?? null) : (remoteMedia.find((publication) => publication.source === "microphone")?.track ?? null),
          videoTrack: local ? (localMedia?.camera.track ?? null) : (remoteMedia.find((publication) => publication.source === "camera")?.track ?? null),
          screenShareTrack: local ? (localMedia?.screen.track ?? null) : (remoteMedia.find((publication) => publication.source === "screen")?.track ?? null),
        };
      }),
    [localParticipantId, snapshot.localMedia, snapshot.participantMedia, snapshot.participants, snapshot.remoteMedia],
  );
  const localParticipant = participants.find((participant) => participant.id === localParticipantId) ?? null;
  const remoteParticipants = participants.filter((participant) => participant.id !== localParticipantId);
  const getParticipant = useCallback((participantSessionId: string) => participants.find((participant) => participant.id === participantSessionId), [participants]);

  return {
    participants,
    localParticipant,
    remoteParticipants,
    activeSpeaker: null,
    count: participants.length,
    participantCount: participants.length,
    getParticipant,
    updateDisplayName: session.setDisplayName,
  };
}
