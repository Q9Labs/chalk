import { useCallback } from "react";

interface ParticipantLike {
  id: string;
  isLocal: boolean;
  audioEnabled: boolean;
}

interface SessionLike {
  muteParticipant: (participantId: string) => void;
  unmuteParticipant: (participantId: string) => void;
  removeParticipant: (participantId: string) => Promise<unknown>;
}

export interface UseParticipantModerationParams {
  canManageParticipants: boolean;
  participants: readonly ParticipantLike[];
  session: SessionLike;
}

export interface UseParticipantModerationReturn {
  handleToggleParticipantMute: (participantId: string) => void;
  handleRemoveParticipant: (participantId: string) => void;
}

export function useParticipantModeration({ canManageParticipants, participants, session }: UseParticipantModerationParams): UseParticipantModerationReturn {
  const handleToggleParticipantMute = useCallback(
    (participantId: string) => {
      if (!canManageParticipants) return;
      const target = participants.find((participant) => participant.id === participantId);
      if (!target || target.isLocal) return;

      if (target.audioEnabled) {
        session.muteParticipant(participantId);
      } else {
        session.unmuteParticipant(participantId);
      }
    },
    [canManageParticipants, participants, session],
  );

  const handleRemoveParticipant = useCallback(
    (participantId: string) => {
      if (!canManageParticipants) return;
      const target = participants.find((participant) => participant.id === participantId);
      if (!target || target.isLocal) return;
      void session.removeParticipant(participantId);
    },
    [canManageParticipants, participants, session],
  );

  return {
    handleToggleParticipantMute,
    handleRemoveParticipant,
  };
}
