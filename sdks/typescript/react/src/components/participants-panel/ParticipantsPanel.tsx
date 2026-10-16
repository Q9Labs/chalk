import React from "react";
import { type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { ClassicParticipantsPanel } from "./ClassicParticipantsPanel";

export interface ParticipantListParticipant {
  id: string;
  displayName: string;
  isLocal?: boolean;
  isMuted?: boolean;
  isVideoEnabled?: boolean;
  isHandRaised?: boolean;
  avatarUrl?: string;
}

export type ParticipantListVariant = "default" | "sidebar" | "mobile";

export interface ParticipantsPanelProps {
  onAddPeople?: () => void;
  searchable?: boolean;
  onClose?: () => void;
  /** Override the media request actions when the host surface owns command feedback. */
  onRequestUnmute?: (id: string) => void | Promise<unknown>;
  onRequestStartCamera?: (id: string) => void | Promise<unknown>;
  /** Receives a cleared value after a successful command and a message after a failed command. */
  onCommandError?: (message: string | null) => void;
  /** Per-participant volume overrides (0-100). Only contains adjusted participants. */
  participantVolumes?: ReadonlyMap<string, number>;
  /** Called when a participant's volume is changed via the slider. */
  onParticipantVolumeChange?: (id: string, volume: number) => void;
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  /** Show a generated Facehash when a Participant has no uploaded avatar. */
  generatedAvatars?: boolean;
  /** Show the capability-gated admission section when the Space enables it. */
  admissionEnabled?: boolean;
  className?: string;
  variant?: ParticipantListVariant;
  title?: string;
}

export const ParticipantsPanel = React.memo((props: ParticipantsPanelProps): React.JSX.Element => {
  return <ClassicParticipantsPanel {...props} />;
});

ParticipantsPanel.displayName = "ParticipantsPanel";
