import type { ParticipantGradientPreference } from "../../utils/colorGenerator";
import type { ParticipantListParticipant, ParticipantListVariant } from "./ParticipantsPanel";
import { ClassicParticipantRow } from "./ClassicParticipantRow";

export interface ParticipantRowProps {
  participant: ParticipantListParticipant;
  variant: ParticipantListVariant;
  canManageParticipants: boolean;
  onMuteParticipant?: (id: string) => void;
  onRequestUnmute?: (id: string) => void | Promise<unknown>;
  onStopParticipantCamera?: (id: string) => void;
  onRequestStartCamera?: (id: string) => void | Promise<unknown>;
  onRemoveParticipant?: (id: string) => void;
  onUpdateDisplayName?: (name: string) => void;
  onCommandError?: (message: string | null) => void;
  participantVolumes?: ReadonlyMap<string, number>;
  onParticipantVolumeChange?: (id: string, volume: number) => void;
  participantGradientPreference?: ParticipantGradientPreference;
  generatedAvatars?: boolean;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onMenuClose: () => void;
}

export function ParticipantRow(props: ParticipantRowProps) {
  return <ClassicParticipantRow {...props} />;
}
