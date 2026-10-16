import React from "react";
import { ClassicSettingsPanel } from "./ClassicSettingsPanel";

export interface SettingsPanelProps {
  enablePictureInPicture?: boolean;
  isPictureInPictureSupported?: boolean;
  isPictureInPictureActive?: boolean;
  autoOpenPictureInPicture?: boolean;
  onAutoOpenPictureInPictureChange?: (enabled: boolean) => void;
  onOpenPictureInPicture?: () => void;

  onClose?: () => void;
  participantColorSeed?: string;
  className?: string;
}

export function SettingsPanel(props: SettingsPanelProps): React.JSX.Element {
  return <ClassicSettingsPanel {...props} />;
}
