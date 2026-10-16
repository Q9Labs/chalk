import React from "react";
import { ClassicDeviceSelector } from "./ClassicDeviceSelector";
import { type ParticipantGradientPreference } from "../../utils/colorGenerator";

type SelectableDevice = Pick<MediaDeviceInfo, "deviceId" | "kind" | "label">;

export interface DeviceSelectorProps {
  type: "audioinput" | "audiooutput" | "videoinput";
  devices: readonly SelectableDevice[];
  selectedDeviceId?: string;
  onChange: (deviceId: string) => void;
  label?: string;
  previewTrack?: MediaStreamTrack | null;
  audioLevel?: number;
  disabled?: boolean;
  participantColorSeed?: string;
  participantGradientPreference?: ParticipantGradientPreference;
  className?: string;
}

export const DeviceSelector = React.memo((props: DeviceSelectorProps): React.JSX.Element => {
  return <ClassicDeviceSelector {...props} />;
});

DeviceSelector.displayName = "DeviceSelector";
