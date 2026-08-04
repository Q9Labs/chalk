import { useCallback, useMemo } from "react";

import { useChalkSession } from "../context/chalk-provider";
import type { NativeParticipant, NativeParticipantState } from "../ui/native-types";
import { useChalkSnapshot } from "./useChalkSnapshot";

export interface UseMeetingParticipantsReturn extends NativeParticipantState {
  readonly remoteParticipants: readonly NativeParticipant[];
  readonly participantCount: number;
  readonly getParticipant: (participantId: string) => NativeParticipant | undefined;
  readonly updateDisplayName: (displayName: string) => Promise<void>;
}

export function useMeetingParticipants(): UseMeetingParticipantsReturn {
  const session = useChalkSession();
  const snapshot = useChalkSnapshot();
  const localParticipantId = snapshot.subject?.participantId ?? null;
  const participants = useMemo(
    () =>
      snapshot.participants.map((participant): NativeParticipant => {
        const participantMedia = participant.media;
        const remoteMedia = snapshot.remoteMedia.filter((publication) => publication.participantId === participant.participantId);
        const local = participant.participantId === localParticipantId;
        const localMedia = local ? snapshot.localMedia : null;
        return {
          ...participant,
          id: participant.participantId,
          audioEnabled: local ? localMedia?.microphone.state === "enabled" : participantMedia?.microphone === "active",
          videoEnabled: local ? localMedia?.camera.state === "enabled" : participantMedia?.camera === "active",
          audioTrack: local ? (localMedia?.microphone.track ?? null) : (remoteMedia.find((publication) => publication.source === "microphone")?.track ?? null),
          videoTrack: local ? (localMedia?.camera.track ?? null) : (remoteMedia.find((publication) => publication.source === "camera")?.track ?? null),
          screenShareTrack: local ? (localMedia?.screen.track ?? null) : (remoteMedia.find((publication) => publication.source === "screen")?.track ?? null),
        };
      }),
    [localParticipantId, snapshot.localMedia, snapshot.participants, snapshot.remoteMedia],
  );
  const localParticipant = participants.find((participant) => participant.id === localParticipantId) ?? null;
  const remoteParticipants = participants.filter((participant) => participant.id !== localParticipantId);
  const getParticipant = useCallback((participantId: string) => participants.find((participant) => participant.id === participantId), [participants]);

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
