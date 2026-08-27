import type { ParticipantListParticipant, ParticipantListVariant } from "./ParticipantsPanel";

export interface ParticipantOptionsMenuProps {
  participant: ParticipantListParticipant;
  variant: ParticipantListVariant;
  canManageParticipants: boolean;
  onClose: () => void;
  onMuteParticipant?: (id: string) => void;
  onRequestUnmute?: (id: string) => void | Promise<unknown>;
  onStopParticipantCamera?: (id: string) => void;
  onRequestStartCamera?: (id: string) => void | Promise<unknown>;
  onRemoveParticipant?: (id: string) => void;
  onEditName?: () => void;
  participantVolumes?: ReadonlyMap<string, number>;
  onParticipantVolumeChange?: (id: string, volume: number) => void;
  onCommandError?: (message: string | null) => void;
}

export function runParticipantAction(action: () => void | Promise<unknown>, onClose: () => void, onCommandError?: (message: string | null) => void): Promise<void> {
  try {
    return Promise.resolve(action()).then(
      () => {
        onCommandError?.(null);
        onClose();
      },
      (cause: unknown) => {
        onCommandError?.(cause instanceof Error ? cause.message : "This Participant action could not be completed.");
      },
    );
  } catch (cause) {
    onCommandError?.(cause instanceof Error ? cause.message : "This Participant action could not be completed.");
    return Promise.resolve();
  }
}
