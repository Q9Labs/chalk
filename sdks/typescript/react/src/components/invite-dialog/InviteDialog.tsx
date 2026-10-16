import React from "react";
import { ClassicInviteDialog } from "./ClassicInviteDialog";

export interface InviteDialogProps {
  isOpen: boolean;
  onClose: () => void;
  inviteLink: string;
  spaceId?: string;
  onCopyLink?: () => void | Promise<void>;
  onShareEmail?: () => void;
  onShareCalendar?: () => void;
  className?: string;
}

export const InviteDialog = React.memo<InviteDialogProps>((props: InviteDialogProps) => {
  return <ClassicInviteDialog {...props} />;
});

InviteDialog.displayName = "InviteDialog";
