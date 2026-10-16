import React from "react";
import { toast } from "sonner";
import { type ParticipantGradientPreference } from "../../utils/colorGenerator";
import { type ThemePalette, type ThemeTexture } from "../theme";
import { ClassicToastStack } from "./ClassicToastStack";

export interface Toast {
  id: string;
  message: string;
  type?: "info" | "success" | "warning" | "error";
  duration?: number;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface ToastStackProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
  position?: "top-right" | "top-left" | "bottom-right" | "bottom-left";
  maxVisible?: number;
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  palette?: ThemePalette;
  texture?: ThemeTexture;
  className?: string;
}

export const ToastStack = React.memo<ToastStackProps>((props) => {
  return <ClassicToastStack {...props} />;
});

ToastStack.displayName = "ToastStack";

export { toast };
