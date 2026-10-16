import React from "react";
import { type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { ClassicReactionPicker } from "./ClassicReactionPicker";

export interface ReactionPickerProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
  recentReactions?: string[];
  allowedReactions?: readonly string[];
  position?: "top" | "bottom";
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  className?: string;
  size?: "default" | "compact" | "mini";
}

export const ReactionPicker = React.memo((props: ReactionPickerProps): React.JSX.Element => {
  return <ClassicReactionPicker {...props} />;
});

ReactionPicker.displayName = "ReactionPicker";
