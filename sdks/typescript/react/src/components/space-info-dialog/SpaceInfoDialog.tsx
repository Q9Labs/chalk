import React from "react";
import { ClassicSpaceInfoDialog } from "./ClassicSpaceInfoDialog";

export interface SpaceInfoDialogProps {
  isOpen: boolean;
  onClose: () => void;
  spaceName: string;
  spaceDescription?: string;
  spaceId?: string;
  inviteLink?: string;
  onCopyLink?: () => void;
  diagnosticReference?: string;
  onCopyDiagnosticReference?: (reference: string) => void;
  onSendFeedback?: (context: Readonly<{ diagnosticReference: string }>) => void;
  isRecording?: boolean;
  isTranscribing?: boolean;
  duration?: number;
  stats?: {
    latency?: number;
    packetLoss?: number;
    bitrate?: string;
    resolution?: string;
    region?: string;
    version?: string;
  };
  className?: string;
}

export const SpaceInfoDialog = React.memo<SpaceInfoDialogProps>((props) => {
  return <ClassicSpaceInfoDialog {...props} />;
});

SpaceInfoDialog.displayName = "SpaceInfoDialog";
