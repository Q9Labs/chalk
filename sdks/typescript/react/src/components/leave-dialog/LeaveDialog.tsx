import React from "react";
import { type ThemePalette, type ThemeTexture } from "../theme";
import { ClassicLeaveDialog } from "./ClassicLeaveDialog";

export interface LeaveDialogProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
  readonly onEndEpisode?: () => void;
  /** Set this to false when the current Participant cannot end the Episode. */
  readonly canEndEpisode?: boolean;
  readonly leavePending?: boolean;
  readonly leaveError?: string | null;
  readonly endEpisodePending?: boolean;
  readonly endEpisodeError?: string | null;
  readonly palette?: ThemePalette;
  readonly texture?: ThemeTexture;
  readonly className?: string;
}

export const LeaveDialog = React.memo<LeaveDialogProps>((props: LeaveDialogProps) => {
  return <ClassicLeaveDialog {...props} />;
});

LeaveDialog.displayName = "LeaveDialog";
