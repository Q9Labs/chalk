import React from "react";
import { type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { ClassicBackgroundEffectsPicker } from "./ClassicBackgroundEffectsPicker";

export interface BackgroundEffect {
  id: string;
  type: "none" | "blur" | "image";
  name: string;
  thumbnail?: string;
  value?: string;
}

export interface BackgroundEffectsPickerProps {
  effects: BackgroundEffect[];
  selectedEffectId?: string;
  onSelect: (effectId: string) => void;
  onCustomUpload?: (file: File) => void;
  disabled?: boolean;
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  className?: string;
}

export const BackgroundEffectsPicker = React.memo((props: BackgroundEffectsPickerProps): React.JSX.Element => {
  return <ClassicBackgroundEffectsPicker {...props} />;
});

BackgroundEffectsPicker.displayName = "BackgroundEffectsPicker";
